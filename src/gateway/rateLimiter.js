import Redis from "ioredis";
const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
});

const WINDOW_TIME = 60;
const MAX_REQUESTS = 10;

export default async function customRateLimiter(req, res, next) {
  // const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  // const rediskey = `rate_limiter:${ip}`;

  // Agar JWT middleware ne user object inject kiya hai, toh userId use karo, nahi toh IP fallback
  const identifier = req.user
    ? req.user.id
    : req.ip || req.headers["x-forwarded-for"] || "unknown";
  const rediskey = `rate_limiter:${identifier}`;

  try {
    const [incrReply, ttlReply] = await redis
      .multi()
      .incr(rediskey)
      .ttl(rediskey) // Yeh check karega ki is key par abhi kitna time bacha hai
      .exec();

    // ioredis responses array formats : [error, value]
    const totalRequests = incrReply[1];
    const currentTTL = ttlReply[1];

    // Agar totalRequests 1 hai, YA fir key galti se bina TTL ke baithi hai (currentTtl === -1)
    if (totalRequests === 1 || currentTTL === -1) {
      await redis.expire(rediskey, WINDOW_TIME); // expiry time in seconds sets
    }

    if (totalRequests > MAX_REQUESTS) {
      res.setHeader("X-RateLimit-Limit", MAX_REQUESTS);
      res.setHeader("X-RateLimit-Remaining", 0);
      
      // return lagane se execution yahi block ho jayegi aur next() call nahi hoga
      return res.status(429).json({
        error: "Too many requests",
        message: "Rate limit exceeded, please try again later.",
      });
    }

    res.setHeader("X-RateLimit-Limit", MAX_REQUESTS);
    res.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, MAX_REQUESTS - totalRequests),
    );

    return next();
  } catch (e) {
    console.error("Distibuted rate limiter error", e);
    next();
  }
}
