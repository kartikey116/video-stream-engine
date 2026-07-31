import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import cors from 'cors';
import customRateLimiter from './gateway/rateLimiter.js';
import handleChunkedUpload from './ingestion/uploadService.js';
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

app.use(cors({
  origin : '*',
  methods: ['GET','POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.use(express.static(path.join(__dirname, '../public')));

// // --- CUSTOM API GATEWAY LAYER INTERCEPTING ROUTES ---
// app.use('/api', customRateLimiter);

// // --- MEDIA INGESTION ROUTING ---
// app.post('/api/v1/upload', handleChunkedUpload);

app.post('/api/v1/upload', customRateLimiter, uploadVideoController);
app.get('/api/v1/search', searchVideosController);

// Route 1: For Master Playlist (e.g., /api/v1/stream/vid_123/master.m3u8)
app.get('/api/v1/stream/:videoId/:file',streamVideoController);

// Route 2: For Sub-variants and Chunks (e.g., /api/v1/stream/vid_123/v0/manifest.m3u8)
app.get('/api/v1/stream/:videoId/:variantDir/:file',streamVideoController);

// Route 3: REAL-TIME PROGRESS SYNC (Server-Sent Events)
import Redis from 'ioredis';
const redisSubscriber = new Redis({ host: '127.0.0.1', port: 6379 });

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
    
    // Subscribe to this specific video's channel
    redisSubscriber.subscribe(channel, (err, count) => {
        if (err) console.error("Failed to subscribe: %s", err.message);
    });

    redisSubscriber.on('message', (subChannel, message) => {
        if (subChannel === channel) {
            // Push the message down to the frontend!
            res.write(`data: ${message}\n\n`);
        }
    });

    // Cleanup when client disconnects
    req.on('close', () => {
        redisSubscriber.unsubscribe(channel);
    });
});

app.listen(PORT, () => {
  console.log(`System Engine online. Listening directly on core gateway port: ${PORT}`);
});