import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
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

connectDB();

async function uploadToMinIO(localFilePath, targetKey) {
    const fileStream = fs.createReadStream(localFilePath);
    await s3Client.send(new PutObjectCommand({
        Bucket: 'processed-videos',
        Key: targetKey,
        Body: fileStream,
        ContentType: targetKey.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/MP2T'
    }));
}

function executeFFmpegJob(args, videoId, label) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args);
        let totalDuration = 0;

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();

            if (!totalDuration && output.includes('Duration:')) {
                const m = output.match(/Duration:\s(\d{2}):(\d{2}):(\d{2})\./);
                if (m) totalDuration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
            }

            if (totalDuration && output.includes('time=')) {
                const tm = output.match(/time=(\d{2}):(\d{2}):(\d{2})\./);
                const sm = output.match(/speed=\s*([\d.]+)x/);
                if (tm) {
                    const current = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]);
                    const percent = Math.min(100, Math.floor((current / totalDuration) * 100));
                    const eta = sm ? Math.round((totalDuration - current) / parseFloat(sm[1])) : 0;
                    redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                        resolution: label, status: 'processing', percent, eta
                    }));
                }
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared download cache — both workers share the same source.mp4 on disk.
// The first worker to call downloadSourceFile starts the download; the second
// finds the file already there (or waits on the same promise if still writing).
// ─────────────────────────────────────────────────────────────────────────────
const downloadCache = new Map(); // inputFilePath → Promise<void>

async function downloadSourceFile(inputFilePath, localPath) {
    if (fs.existsSync(localPath)) {
        console.log(`[Worker] Source already on disk — skipping download`);
        return;
    }
    if (!downloadCache.has(inputFilePath)) {
        console.log(`[Worker] Downloading source file...`);
        const dlPromise = (async () => {
            const s3Response = await s3Client.send(new GetObjectCommand({
                Bucket: 'raw-videos',
                Key: inputFilePath
            }));
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(localPath);
                s3Response.Body.pipe(ws);
                s3Response.Body.on('end', resolve);
                s3Response.Body.on('error', reject);
            });
            console.log(`[Worker] Source cached: ${localPath}`);
        })();
        downloadCache.set(inputFilePath, dlPromise);
    }
    await downloadCache.get(inputFilePath);
}

// Ref count — track how many workers are still using the shared workspace.
// When it reaches 0 the last worker deletes the whole directory.
const videoRefCount = new Map(); // videoId → number

function acquireRef(videoId) {
    videoRefCount.set(videoId, (videoRefCount.get(videoId) || 0) + 1);
}

function releaseRef(videoId, inputFilePath, sharedDir) {
    const remaining = (videoRefCount.get(videoId) || 1) - 1;
    if (remaining <= 0) {
        videoRefCount.delete(videoId);
        downloadCache.delete(inputFilePath);
        if (fs.existsSync(sharedDir)) {
            fs.rmSync(sharedDir, { recursive: true, force: true });
            console.log(`[Worker] Workspace cleaned for ${videoId}`);
        }
    } else {
        videoRefCount.set(videoId, remaining);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER VIDEO WORKER
// Decodes the video ONCE and encodes all 4 HLS resolution tiers simultaneously
// in a single FFmpeg process — far faster than 4 separate FFmpeg processes.
// ─────────────────────────────────────────────────────────────────────────────
function createMasterVideoWorker() {
    return new Worker('transcode-master', async (job) => {
        const { videoId, inputFilePath } = job.data;
        console.log(`\n[Master-Worker] Job received for ${videoId}`);

        const sharedDir  = path.join(__dirname, '../../storage/scratchpad', videoId);
        const sourceFile = path.join(sharedDir, 'source.mp4');
        const layers     = ['v0', 'v1', 'v2', 'v3'];

        // Create all output directories upfront
        for (const layer of layers) {
            fs.mkdirSync(path.join(sharedDir, layer), { recursive: true });
        }
        acquireRef(videoId);

        try {
            await downloadSourceFile(inputFilePath, sourceFile);

            // Use forward-slash paths for FFmpeg on Windows
            const wd  = sharedDir.replace(/\\/g, '/');
            const src = sourceFile.replace(/\\/g, '/');

            // ── Single-pass multi-output FFmpeg ──────────────────────────────
            // split filter decodes once → feeds 4 independent scale+encode chains
            const ffmpegArgs = [
                '-y', '-i', src,
                '-filter_complex',
                '[0:v]split=4[s0][s1][s2][s3];' +
                '[s0]scale=1920:1080[v0];[s1]scale=1280:720[v1];' +
                '[s2]scale=854:480[v2];[s3]scale=426:240[v3]',

                // ── 1080p ────────────────────────────────────────────────────
                '-map', '[v0]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high',
                '-b:v', '4500k', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
                '-hls_segment_filename', `${wd}/v0/file_%03d.ts`, `${wd}/v0/manifest.m3u8`,

                // ── 720p ─────────────────────────────────────────────────────
                '-map', '[v1]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main',
                '-b:v', '2500k', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
                '-hls_segment_filename', `${wd}/v1/file_%03d.ts`, `${wd}/v1/manifest.m3u8`,

                // ── 480p ─────────────────────────────────────────────────────
                '-map', '[v2]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main',
                '-b:v', '1000k', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
                '-hls_segment_filename', `${wd}/v2/file_%03d.ts`, `${wd}/v2/manifest.m3u8`,

                // ── 240p ─────────────────────────────────────────────────────
                '-map', '[v3]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline',
                '-b:v', '400k', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
                '-hls_segment_filename', `${wd}/v3/file_%03d.ts`, `${wd}/v3/manifest.m3u8`,
            ];

            await executeFFmpegJob(ffmpegArgs, videoId, 'all-resolutions');
            console.log(`[Master-Worker] Encode complete. Uploading all segments in parallel...`);

            // ── Parallel upload of all 4 resolution outputs ──────────────────
            const allUploads = [];
            for (const layer of layers) {
                const layerDir = path.join(sharedDir, layer);
                for (const file of fs.readdirSync(layerDir)) {
                    allUploads.push(uploadToMinIO(
                        path.join(layerDir, file),
                        `${videoId}/${layer}/${file}`
                    ));
                }
            }
            await Promise.all(allUploads);
            console.log(`[Master-Worker] All segments uploaded.`);

            // Emit individual completion events per resolution so the existing
            // frontend progress logic (which counts 4 video tracks) still works.
            const resolutions = ['1920x1080', '1280x720', '854x480', '426x240'];
            for (const res of resolutions) {
                redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                    resolution: res, status: 'completed'
                }));
            }

            await supabase.from('videos').update({ status: 'ready' }).eq('videoId', videoId);

            // Delete only the output layer dirs. Leave source.mp4 for AI worker.
            for (const layer of layers) {
                fs.rmSync(path.join(sharedDir, layer), { recursive: true, force: true });
            }
            releaseRef(videoId, inputFilePath, sharedDir);
            return { status: 'success' };

        } catch (error) {
            console.error(`[Master-Worker-Error] Transcode failed for ${videoId}:`, error);
            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: '1920x1080', status: 'error', message: error.message
            }));
            await supabase.from('videos').update({ status: 'error' }).eq('videoId', videoId);
            releaseRef(videoId, inputFilePath, sharedDir);
            throw error;
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

        const sharedDir    = path.join(__dirname, '../../storage/scratchpad', videoId);
        const sourceFile   = path.join(sharedDir, 'source.mp4');
        const aiWorkDir    = path.join(sharedDir, 'ai-workspace');
        fs.mkdirSync(aiWorkDir, { recursive: true });
        acquireRef(videoId);

        try {
            await downloadSourceFile(inputFilePath, sourceFile);

            const audioPath = path.join(aiWorkDir, 'audio.mp3');
            console.log(`[Worker-AI] Extracting audio for ${videoId}...`);
            await executeFFmpegJob(
                ['-i', sourceFile, '-vn', '-acodec', 'libmp3lame', '-ab', '128k', audioPath],
                videoId, 'audio-only'
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
                    model: 'gemini-2.0-flash',
                    contents: [
                        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                        "Generate a highly accurate text transcript of this audio. Do not include timestamps, just the raw spoken text."
                    ]
                });
                const transcriptText = transcriptResponse.text;

                console.log(`[Worker-AI] Transcript ready (${transcriptText.length} chars). Embedding...`);
                const embedResponse = await ai.models.embedContent({
                    model: 'gemini-embedding-2',
                    contents: `title: none | text: ${transcriptText}`,
                    config: { outputDimensionality: 768 }
                });
                const embeddings = embedResponse.embeddings[0].values;

                await supabase.from('videos')
                    .update({ transcript: transcriptText, embedding: embeddings })
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
                    console.warn(`[Worker-AI] Quota exhausted for ${videoId} — skipping enrichment.`);
                } else {
                    throw aiError;
                }
            }

            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: 'audio-only', status: 'completed'
            }));

            // Delete AI workspace, then release the shared dir ref
            fs.rmSync(aiWorkDir, { recursive: true, force: true });
            releaseRef(videoId, inputFilePath, sharedDir);
            return { status: 'success', resolution: 'audio-only' };

        } catch (error) {
            console.error(`[Worker-AI-Error] AI failed for ${videoId}:`, error);
            redisConnection.publish(`progress:${videoId}`, JSON.stringify({
                resolution: 'audio-only', status: 'error', message: error.message
            }));
            fs.rmSync(aiWorkDir, { recursive: true, force: true });
            releaseRef(videoId, inputFilePath, sharedDir);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 1,
        lockDuration: 600000
    });
}

console.log("[Transcode-Worker] Booting master-video + AI workers...");
createMasterVideoWorker();
createAIWorker();
console.log("[Transcode-Worker] Both workers active and listening!");