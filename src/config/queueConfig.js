import Redis from 'ioredis';

// Establish connection pool to local/cloud Redis Node
const redisConnection = new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null // Critical rule alignment required by BullMQ framework
});

export { redisConnection };