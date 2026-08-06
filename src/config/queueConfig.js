import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

export const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
export const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;

// Establish connection pool to local/cloud Redis Node
const redisConnection = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null // Critical rule alignment required by BullMQ framework
});

export { redisConnection };
