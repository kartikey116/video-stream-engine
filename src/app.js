import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import cors from 'cors';
import customRateLimiter from './gateway/rateLimiter.js';
import {uploadVideoController} from './controllers/uploadController.js';
import {streamVideoController} from './controllers/streamController.js';
import {searchVideosController} from './controllers/searchController.js';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first'); // Fixes Node.js fetch ConnectTimeoutErrors on IPv6

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { connectDB } from './config/dbConfig.js';
connectDB(); // Initialize MongoDB Connection

const app = express();
const PORT = process.env.PORT || 8000;

// Behind the nginx Ingress every request arrives from the controller pod's IP.
// Without this, req.ip is that single IP and the rate limiter buckets the entire
// internet together. 1 = trust exactly one proxy hop (the Ingress); trusting
// blindly would let clients spoof X-Forwarded-For.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

app.use(cors({
  origin : '*',
  methods: ['GET','POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.use(express.static(path.join(__dirname, '../public')));

// // --- CUSTOM API GATEWAY LAYER INTERCEPTING ROUTES ---
// app.use('/api', customRateLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH PROBES
// These exist so Kubernetes never has to probe a real endpoint. The probes used
// to hit /api/v1/search?q=health, which runs a Gemini embedding call plus a
// Supabase RPC on every check — that burns API quota every 15s per pod, and the
// moment Gemini rate-limits, search returns 500, the liveness probe fails, and
// K8s restarts perfectly healthy pods into a CrashLoopBackOff.
//
//   /healthz — liveness. Cheap and dependency-free: if the event loop can answer,
//              the process is alive. A failure here means "restart me".
//   /readyz  — readiness. Checks Redis, because an API pod that can't reach Redis
//              can't enqueue jobs or serve SSE progress. A failure here means
//              "take me out of the Service", not "restart me".
// ─────────────────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/readyz', async (_req, res) => {
    try {
        await redisConnection.ping();
        return res.status(200).json({ status: 'ready' });
    } catch (err) {
        return res.status(503).json({ status: 'degraded', error: err.message });
    }
});

app.post('/api/v1/upload', customRateLimiter, uploadVideoController);
app.get('/api/v1/search', searchVideosController);

// Route 1: For Master Playlist (e.g., /api/v1/stream/vid_123/master.m3u8)
app.get('/api/v1/stream/:videoId/:file',streamVideoController);

// Route 2: For Sub-variants and Chunks (e.g., /api/v1/stream/vid_123/v0/manifest.m3u8)
app.get('/api/v1/stream/:videoId/:variantDir/:file',streamVideoController);

// Route 3: REAL-TIME PROGRESS SYNC (Server-Sent Events)
import Redis from 'ioredis';
import { REDIS_HOST, REDIS_PORT, redisConnection } from './config/queueConfig.js';

// A dedicated connection: an ioredis client in subscriber mode cannot issue
// normal commands, so this must stay separate from the BullMQ pool.
const redisSubscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

// channel → Set of response objects currently watching it.
// One Redis subscription per channel is shared by every client, and the single
// 'message' handler below fans out. The previous version registered a new
// listener per request (leaking one per connection, and eventually tripping
// Node's max-listeners warning) and unsubscribed the whole channel as soon as
// any one client disconnected, silently cutting off everyone else.
const progressClients = new Map();

redisSubscriber.on('message', (channel, message) => {
    const subscribers = progressClients.get(channel);
    if (!subscribers) return;
    for (const client of subscribers) {
        client.write(`data: ${message}\n\n`);
    }
});

app.get('/api/v1/stream-progress/:videoId', (req, res) => {
    const videoId = req.params.videoId;

    // Set headers for SSE (Server-Sent Events)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Tell client we connected
    res.write(`data: ${JSON.stringify({ message: "Connected to Live Progress Sync" })}\n\n`);

    const channel = `progress:${videoId}`;

    if (!progressClients.has(channel)) {
        progressClients.set(channel, new Set());
        redisSubscriber.subscribe(channel, (err) => {
            if (err) console.error("Failed to subscribe: %s", err.message);
        });
    }
    progressClients.get(channel).add(res);

    // Proxies and load balancers drop idle connections; a comment line keeps
    // the socket warm without reaching the client's onmessage handler.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        const subscribers = progressClients.get(channel);
        if (!subscribers) return;
        subscribers.delete(res);
        // Only tear the subscription down once the last watcher has left.
        if (subscribers.size === 0) {
            progressClients.delete(channel);
            redisSubscriber.unsubscribe(channel);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIPT ENDPOINT
// Returns the AI-generated timestamped transcript segments for a given videoId.
// The frontend uses these to show a synced, scrollable transcript panel.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './config/dbConfig.js';

app.get('/api/v1/transcript/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const { data, error } = await supabase
        .from('videos')
        .select('transcript_segments, transcript, title')
        .eq('videoId', videoId)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: 'Transcript not found.' });
    }
    return res.status(200).json({
        videoId,
        title: data.title,
        segments: data.transcript_segments || [],
        fullTranscript: data.transcript || ''
    });
});

const server = app.listen(PORT, () => {
  console.log(`System Engine online. Listening directly on core gateway port: ${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// tini forwards SIGTERM from K8s. Without a handler Node's default is to exit
// immediately, cutting in-flight uploads and every open SSE stream on each
// rolling update. Closing the server stops new connections while existing ones
// drain; K8s SIGKILLs anything still alive at terminationGracePeriodSeconds.
// ─────────────────────────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[API] ${signal} received — draining connections...`);

    // End the SSE streams explicitly: they never finish on their own, so
    // server.close() would otherwise wait for them until the grace period ends.
    for (const subscribers of progressClients.values()) {
        for (const client of subscribers) client.end();
    }
    progressClients.clear();

    server.close(async () => {
        try {
            await Promise.allSettled([redisSubscriber.quit(), redisConnection.quit()]);
        } finally {
            console.log('[API] Drained. Exiting.');
            process.exit(0);
        }
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));