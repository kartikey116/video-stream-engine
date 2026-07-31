import { Queue } from 'bullmq';
import { redisConnection } from '../config/queueConfig.js';

// 2 queues instead of 5:
//   transcode-master → single FFmpeg job that encodes ALL 4 resolutions at once
//   transcode-ai     → audio extraction + Gemini transcription + vector embedding
export const queues = {
    'master': new Queue('transcode-master', { connection: redisConnection }),
    'ai':     new Queue('transcode-ai',     { connection: redisConnection })
};

export async function dispatchTranscodeJobs(inputFilePath, videoId) {
    console.log(`\n🚀 [Queue-Producer] Dispatching master-video + AI jobs for ${videoId}...`);

    await Promise.all([
        queues['master'].add(`job-${videoId}-master`, { videoId, inputFilePath }, {
            attempts: 2,
            backoff: 5000
        }),
        queues['ai'].add(`job-${videoId}-ai`, { videoId, inputFilePath }, {
            attempts: 1 // AI quota errors are handled internally; no point retrying
        })
    ]);

    console.log(`📌 [Queue-Producer] Jobs dispatched for ${videoId}`);
}