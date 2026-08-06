import fs from 'fs';
import path from 'path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Worker } from 'bullmq';
import { redisConnection } from '../config/queueConfig.js';
import s3Client from '../config/s3Client.js';
import { connectDB, supabase } from '../config/dbConfig.js';
import { GoogleGenAI } from '@google/genai';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRATCHPAD = path.join(__dirname, '../../storage/scratchpad');

connectDB();

// ─────────────────────────────────────────────────────────────────────────────
// HLS ABR LADDER
// Ordered highest → lowest. Tiers taller than the source are dropped at runtime
// so we never upscale. maxrate/bufsize cap the peaks — without them the
// BANDWIDTH values advertised in master.m3u8 are unenforced guesses and players
// make bad switching decisions.
// ─────────────────────────────────────────────────────────────────────────────
const ALL_LAYERS = [
    { name: 'v0', w: 1920, h: 1080, bitrate: '4500k', maxrate: '4950k', bufsize: '9000k', profile: 'high',     bandwidth: 4950000 },
    { name: 'v1', w: 1280, h: 720,  bitrate: '2500k', maxrate: '2750k', bufsize: '5000k', profile: 'main',     bandwidth: 2750000 },
    { name: 'v2', w: 854,  h: 480,  bitrate: '1000k', maxrate: '1100k', bufsize: '2000k', profile: 'main',     bandwidth: 1100000 },
    { name: 'v3', w: 426,  h: 240,  bitrate: '400k',  maxrate: '440k',  bufsize: '800k',  profile: 'baseline', bandwidth: 440000  },
];

function buildLadder(sourceHeight) {
    const ladder = sourceHeight > 0
        ? ALL_LAYERS.filter(l => l.h <= sourceHeight)
        : [...ALL_LAYERS]; // probe failed — encode the full ladder rather than guess
    return ladder.length ? ladder : [ALL_LAYERS[ALL_LAYERS.length - 1]];
}

function buildFfmpegArgs(src, wd, ladder) {
    // Decode once, split into N independent scale+encode chains.
    // force_original_aspect_ratio=decrease + pad letterboxes instead of
    // stretching; setsar=1 stops a non-square source SAR reaching the output.
    const filter =
        `[0:v]split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')};` +
        ladder.map((l, i) =>
            `[s${i}]scale=${l.w}:${l.h}:force_original_aspect_ratio=decrease,` +
            `pad=${l.w}:${l.h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
        ).join(';');

    const outputs = ladder.flatMap((l, i) => [
        '-map', `[v${i}]`, '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', l.profile,
        '-b:v', l.bitrate, '-maxrate', l.maxrate, '-bufsize', l.bufsize,
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        // GOP alignment across every tier — required for seamless ABR switching
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
        // Cap max_muxing_queue_size to prevent OOM when all
        // tiers finalize simultaneously (fixes exit code -12 / ENOMEM).
        // Limit threads per encoder to 4 to prevent massive CPU context-switching
        // thrashing when 4 tiers try to spawn 24 threads each simultaneously.
        '-threads', '4', '-max_muxing_queue_size', '4096',
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
        '-hls_segment_filename', `${wd}/${l.name}/file_%03d.ts`, `${wd}/${l.name}/manifest.m3u8`,
    ]);

    return ['-y', '-i', src, '-filter_complex', filter, ...outputs];
}

function buildMasterPlaylist(ladder) {
    return '#EXTM3U\n#EXT-X-VERSION:3\n' + ladder.map(l =>
        `#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth},RESOLUTION=${l.w}x${l.h}\n${l.name}/manifest.m3u8`
    ).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function uploadToMinIO(localFilePath, targetKey) {
    const fileStream = fs.createReadStream(localFilePath);
    await s3Client.send(new PutObjectCommand({
        Bucket: 'processed-videos',
        Key: targetKey,
        Body: fileStream,
        ContentType: targetKey.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/MP2T'
    }));
}

async function putTextToMinIO(text, targetKey, contentType) {
    await s3Client.send(new PutObjectCommand({
        Bucket: 'processed-videos',
        Key: targetKey,
        Body: text,
        ContentType: contentType
    }));
}

// Download to a `.part` file and rename on completion. rename is atomic, so a
// file visible at localPath is always a complete file — never the zero-byte
// stub that fs.createWriteStream leaves behind on its first tick.
async function downloadSourceFile(bucketKey, localPath) {
    const partPath = `${localPath}.part`;
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    console.log(`[Worker] Downloading source ${bucketKey}...`);
    const s3Response = await s3Client.send(new GetObjectCommand({
        Bucket: 'raw-videos',
        Key: bucketKey
    }));

    // pipeline resolves on the writable's 'finish', not the readable's 'end',
    // so the bytes are actually flushed to disk before we return.
    await pipeline(s3Response.Body, fs.createWriteStream(partPath));
    fs.renameSync(partPath, localPath);

    const { size } = fs.statSync(localPath);
    if (size === 0) throw new Error(`Downloaded source is empty: ${bucketKey}`);
    console.log(`[Worker] Source cached (${size} bytes): ${localPath}`);
}

// Remove workspaces left behind by crashed/killed runs. Live jobs always clean
// up in their own `finally`, so anything older than the max lock duration is dead.
function sweepScratchpad(maxAgeMs = 6 * 60 * 60 * 1000) {
    if (!fs.existsSync(SCRATCHPAD)) return;
    for (const entry of fs.readdirSync(SCRATCHPAD)) {
        const target = path.join(SCRATCHPAD, entry);
        try {
            if (Date.now() - fs.statSync(target).mtimeMs > maxAgeMs) {
                fs.rmSync(target, { recursive: true, force: true });
                console.log(`[Worker] Swept orphaned workspace: ${entry}`);
            }
        } catch (err) {
            console.warn(`[Worker] Could not sweep ${entry}: ${err.message}`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function probeSource(src) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'format=duration:stream=width,height',
            '-of', 'json', src
        ]);
        let stdout = '';
        ffprobe.stdout.on('data', (d) => { stdout += d; });
        ffprobe.on('error', (err) => reject(new Error(`Failed to spawn ffprobe: ${err.message}`)));
        ffprobe.on('close', (code) => {
            if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
            try {
                const parsed = JSON.parse(stdout);
                resolve({
                    duration: parseFloat(parsed.format?.duration) || 0,
                    width:  parsed.streams?.[0]?.width  || 0,
                    height: parsed.streams?.[0]?.height || 0
                });
            } catch (err) {
                reject(new Error(`Could not parse ffprobe output: ${err.message}`));
            }
        });
    });
}

/**
 * Runs FFmpeg to completion.
 * @param label  Progress channel label. Pass null to suppress progress events —
 *               used by side jobs that must not drive the frontend progress bar.
 */
function executeFFmpegJob(args, videoId, label, totalDuration = 0) {
    return new Promise((resolve, reject) => {
        // -progress pipe:1 emits machine-readable key=value blocks on stdout.
        // Far more reliable than regexing the stderr status line, which gets
        // split across chunk boundaries, and it reports one unified timeline
        // for the whole command instead of interleaving the four encoders.
        const ffmpeg = spawn('ffmpeg', ['-nostats', '-progress', 'pipe:1', ...args]);

        let stderrTail = '';
        let stdoutBuffer = '';
        let lastPercent = -1;

        ffmpeg.stdout.on('data', (chunk) => {
            stdoutBuffer += chunk.toString();
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop(); // retain the trailing partial line

            let current = null;
            let speed = null;
            for (const line of lines) {
                const [key, value] = line.split('=');
                if (key === 'out_time_us') current = parseInt(value, 10) / 1e6;
                else if (key === 'speed') speed = parseFloat(value);
            }

            if (!label || !totalDuration || !Number.isFinite(current)) return;

            const percent = Math.min(100, Math.floor((current / totalDuration) * 100));
            if (percent === lastPercent) return; // don't spam Redis on every tick
            lastPercent = percent;

            const eta = speed > 0 ? Math.round((totalDuration - current) / speed) : 0;
            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: label, status: 'processing', percent, eta
            }));
        });

        // Keep the tail of stderr so a non-zero exit reports *why*, not just a code.
        ffmpeg.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

        // Without this, a missing/unspawnable ffmpeg leaves the promise pending
        // forever and the job hangs until the BullMQ lock expires.
        ffmpeg.on('error', (err) => reject(new Error(`Failed to spawn FFmpeg: ${err.message}`)));

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}\n${stderrTail}`));
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER VIDEO WORKER
// Decodes the video ONCE and encodes every HLS tier simultaneously in a single
// FFmpeg process — far faster than one FFmpeg process per tier.
// ─────────────────────────────────────────────────────────────────────────────
function createMasterVideoWorker() {
    return new Worker('transcode-master', async (job) => {
        const { videoId, inputFilePath } = job.data;
        console.log(`\n[Master-Worker] Job received for ${videoId}`);

        // Private workspace per worker. The two workers no longer share a
        // directory, which removes the ref-counting entirely: neither can delete
        // a source file the other is still reading, and a BullMQ retry can't
        // double-count its way into a workspace that never gets cleaned.
        const workDir    = path.join(SCRATCHPAD, `${videoId}-master`);
        const sourceFile = path.join(workDir, 'source.mp4');

        try {
            fs.mkdirSync(workDir, { recursive: true });
            await downloadSourceFile(inputFilePath, sourceFile);

            // Forward-slash paths for FFmpeg on Windows
            const wd  = workDir.replace(/\\/g, '/');
            const src = sourceFile.replace(/\\/g, '/');

            let source = { duration: 0, width: 0, height: 0 };
            try {
                source = await probeSource(src);
            } catch (probeErr) {
                console.warn(`[Master-Worker] Probe failed (${probeErr.message}) — using full ladder, no progress %.`);
            }

            const ladder = buildLadder(source.height);
            console.log(
                `[Master-Worker] Source ${source.width}x${source.height} ` +
                `(${source.duration.toFixed(1)}s) → ${ladder.length} tier(s): ` +
                ladder.map(l => `${l.w}x${l.h}`).join(', ')
            );

            for (const layer of ladder) {
                fs.mkdirSync(path.join(workDir, layer.name), { recursive: true });
            }

            await executeFFmpegJob(
                buildFfmpegArgs(src, wd, ladder),
                videoId, 'all-resolutions', source.duration
            );
            console.log(`[Master-Worker] Encode complete. Uploading all segments in parallel...`);

            const allUploads = [];
            for (const layer of ladder) {
                const layerDir = path.join(workDir, layer.name);
                for (const file of fs.readdirSync(layerDir)) {
                    allUploads.push(uploadToMinIO(
                        path.join(layerDir, file),
                        `${videoId}/${layer.name}/${file}`
                    ));
                }
            }
            await Promise.all(allUploads);

            // The master playlist is written here rather than at upload time:
            // the tier list isn't known until the source has been probed.
            await putTextToMinIO(
                buildMasterPlaylist(ladder),
                `${videoId}/master.m3u8`,
                'application/x-mpegURL'
            );
            console.log(`[Master-Worker] All segments + master playlist uploaded.`);

            // `total` lets the frontend know how many tiers to wait for instead
            // of assuming a fixed four.
            for (const layer of ladder) {
                redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                    resolution: `${layer.w}x${layer.h}`, status: 'completed', total: ladder.length
                }));
            }

            await supabase.from('videos').update({ status: 'ready' }).eq('videoId', videoId);
            return { status: 'success', tiers: ladder.length };

        } catch (error) {
            console.error(`[Master-Worker-Error] Transcode failed for ${videoId}:`, error);
            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: 'all-resolutions', status: 'error', message: error.message
            }));
            await supabase.from('videos').update({ status: 'error' }).eq('videoId', videoId);
            throw error;

        } finally {
            // Single cleanup path — runs on success, failure, and retry alike.
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }, {
        connection: redisConnection,
        concurrency: 1,
        lockDuration: 1200000 // 20 min for large videos
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI WORKER — Audio extraction + Gemini transcription + vector embedding
// ─────────────────────────────────────────────────────────────────────────────
function createAIWorker() {
    return new Worker('transcode-ai', async (job) => {
        const { videoId, inputFilePath } = job.data;
        console.log(`\n[Worker-AI] Job received for ${videoId}`);

        const workDir    = path.join(SCRATCHPAD, `${videoId}-ai`);
        const sourceFile = path.join(workDir, 'source.mp4');
        const audioPath  = path.join(workDir, 'audio.mp3');

        try {
            fs.mkdirSync(workDir, { recursive: true });
            await downloadSourceFile(inputFilePath, sourceFile);

            const metadata = await getVideoMetadata(sourceFile);
            const durationSec = Math.round(metadata.duration);

            console.log(`[Worker-AI] Extracting audio for ${videoId} (Duration: ${durationSec}s)...`);
            // label = null: this runs concurrently with the master encode and
            // must not fight it for the frontend's progress bar.
            await executeFFmpegJob(
                ['-y', '-i', sourceFile, '-vn', '-acodec', 'libmp3lame', '-ab', '128k', audioPath],
                videoId, null
            );

            console.log(`[Worker-AI] Audio extracted. Sending to Gemini...`);
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

            try {
                const uploadResult = await ai.files.upload({ file: audioPath, mimeType: 'audio/mp3' });

                let fileState = await ai.files.get({ name: uploadResult.name });
                while (fileState.state === 'PROCESSING') {
                    await new Promise(r => setTimeout(r, 2000));
                    fileState = await ai.files.get({ name: uploadResult.name });
                }

                const transcriptResponse = await ai.models.generateContent({
                    model: 'gemini-3.1-pro-preview',
                    contents: [
                        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                        `Generate a highly accurate text transcript of this audio.
Return ONLY a JSON array of objects, nothing else. No markdown, no code fences.
Each object must have exactly two fields:
  "t": the start time of the segment in seconds (integer),
  "s": the spoken text for that segment (string).

CRITICAL CONSTRAINTS:
1. The total duration of this audio is ${durationSec} seconds.
2. DO NOT generate ANY timestamps ("t" values) that exceed ${durationSec}.
3. The first segment must start with "t": 0.

Example output:
[{"t":0,"s":"Hello and welcome to this video."},{"t":4,"s":"Today we will be discussing something important."}]

Keep segments short (1-3 sentences each). Be precise about timing.`
                    ]
                });

                // Parse the timestamped segments returned by Gemini
                let segments = [];
                let transcriptText = '';
                try {
                    const rawText = transcriptResponse.text.trim()
                        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
                    segments = JSON.parse(rawText);
                    if (!Array.isArray(segments)) segments = [];
                    // Build flat transcript from the segments for embedding / search
                    transcriptText = segments.map(s => s.s).join(' ');
                } catch (parseErr) {
                    // Fallback: treat full response as a plain transcript with no timestamps
                    console.warn(`[Worker-AI] Failed to parse timestamped segments, falling back to plain text.`);
                    transcriptText = transcriptResponse.text;
                    segments = [{ t: 0, s: transcriptText }];
                }

                console.log(`[Worker-AI] Transcript ready (${transcriptText.length} chars). Embedding...`);
                const embedResponse = await ai.models.embedContent({
                    model: 'gemini-embedding-2',
                    contents: `title: none | text: ${transcriptText}`,
                    config: { outputDimensionality: 768 }
                });
                const embeddings = embedResponse.embeddings[0].values;

                await supabase.from('videos')
                    .update({ transcript: transcriptText, embedding: embeddings, transcript_segments: segments })
                    .eq('videoId', videoId);

                console.log(`[Worker-AI] AI pipeline complete for ${videoId}.`);

            } catch (aiError) {
                const isQuotaError = aiError.status === 429 ||
                    (aiError.message && (
                        aiError.message.includes('RESOURCE_EXHAUSTED') ||
                        aiError.message.includes('quota') ||
                        aiError.message.includes('rate limit')
                    ));
                if (isQuotaError) {
                    // Re-throw so BullMQ retries with exponential backoff.
                    // The free tier resets every 60s; 3 attempts with
                    // 60s/120s/240s delays will land in a fresh window.
                    console.warn(`[Worker-AI] Quota exhausted for ${videoId} — will retry via BullMQ backoff.`);
                    throw aiError;
                } else {
                    throw aiError;
                }
            }

            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: 'audio-only', status: 'completed'
            }));
            return { status: 'success', resolution: 'audio-only' };

        } catch (error) {
            console.error(`[Worker-AI-Error] AI failed for ${videoId}:`, error);
            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: 'audio-only', status: 'error', message: error.message
            }));
            throw error;

        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }, {
        connection: redisConnection,
        concurrency: 1,
        lockDuration: 600000
    });
}

console.log("[Transcode-Worker] Booting master-video + AI workers...");
sweepScratchpad();
const masterWorker = createMasterVideoWorker();
const aiWorker = createAIWorker();
console.log("[Transcode-Worker] Both workers active and listening!");

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH ENDPOINT
// The worker has no HTTP server of its own, so the K8s liveness probe used to be
// `node -e "process.exit(0)"` — which spawns a brand new Node process and always
// succeeds. It reports nothing about the actual worker (a hung or Redis-detached
// worker passed it happily) and costs a ~50MB process spawn every 30s.
//
// This server answers for the real process instead:
//   /healthz — the event loop is responsive and the BullMQ workers are running
//   /readyz  — plus Redis is reachable
// ─────────────────────────────────────────────────────────────────────────────
const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT, 10) || 9100;
let shuttingDown = false;

const healthServer = http.createServer(async (req, res) => {
    const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    if (req.url === '/healthz') {
        // During shutdown the process is alive on purpose (finishing a job) —
        // still report healthy so K8s doesn't restart it out from under BullMQ.
        const running = masterWorker.isRunning() && aiWorker.isRunning();
        return running || shuttingDown
            ? send(200, { status: 'ok', draining: shuttingDown })
            : send(503, { status: 'workers-stopped' });
    }

    if (req.url === '/readyz') {
        if (shuttingDown) return send(503, { status: 'draining' });
        try {
            await redisConnection.ping();
            return send(200, { status: 'ready' });
        } catch (err) {
            return send(503, { status: 'redis-unreachable', error: err.message });
        }
    }

    return send(404, { error: 'not found' });
});

healthServer.listen(HEALTH_PORT, () => {
    console.log(`[Transcode-Worker] Health endpoint listening on :${HEALTH_PORT}`);
});

// Graceful shutdown for Kubernetes / KEDA
async function shutdown(signal) {
    // SIGTERM followed by SIGINT (or a repeated SIGTERM) would otherwise close
    // the workers twice and race two process.exit calls.
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Transcode-Worker] ${signal} received. Closing workers gracefully (this lets current jobs finish)...`);
    healthServer.close();
    await Promise.all([
        masterWorker.close(),
        aiWorker.close()
    ]);
    // Without this the ioredis connection keeps the event loop alive and the pod
    // sits until K8s SIGKILLs it at the end of terminationGracePeriodSeconds.
    await redisConnection.quit().catch(() => {});
    console.log("[Transcode-Worker] Workers closed. Exiting process.");
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
