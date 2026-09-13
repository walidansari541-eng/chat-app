const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { randomUUID } = require('node:crypto');
const redisClient = require("./redisClient");

const correlationIdMiddleware = (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);
    next();
}

const chatRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // Limit each IP to 5 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    store: new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    }),
    message: 'Too many requests from this IP, please try again after a minute.',
})

module.exports = { correlationIdMiddleware, chatRateLimiter };