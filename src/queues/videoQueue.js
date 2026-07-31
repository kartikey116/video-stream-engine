import { Queue } from "bullmq";
import Redis from "ioredis";

const redisConnection = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});

export const videoQueue = new Queue('video-transcoding', {
    connection: redisConnection,
});

export async function addVideoToTranscodeQueue(videoId, fileName){
    try {
        const job = await videoQueue.add(`transcode_${videoId}`, {
            videoId,
            fileName,
            timestamp: Date.now()
        },{
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000
            },
            removeOnComplete: true,
            removeOnFail: false
        });

        console.log(`[Queue-Manager] Job gracefully registered in BullMQ: JobID ${job.id} for ${videoId}`);
        return job;
    } catch (err) {
        console.error(`[Queue-Error] Failed to push job to BullMQ framework:`, err);
        throw err;
    }
}