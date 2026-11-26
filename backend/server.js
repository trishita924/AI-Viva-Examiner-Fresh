import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import vivaRoutes from './routes/vivaRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

// Trust reverse proxy (required on Render for accurate rate limiting & HTTPS headers)
app.set('trust proxy', 1);

// Security HTTP headers
app.use(helmet());

// Parse explicit allowed frontend origins from environment
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools (curl, health checks) with no Origin header
      if (!origin) {
        return callback(null, true);
      }
      const normalizedOrigin = origin.replace(/\/+$/, '');
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }
      // In local development, allow localhost / 127.0.0.1 if ALLOWED_ORIGINS is unset
      if (!isProd && allowedOrigins.length === 0 && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalizedOrigin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: Origin ${normalizedOrigin} is not allowed.`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400
  })
);

// Request body size limit (protects against oversized payloads)
app.use(express.json({ limit: '150kb' }));

// Global rate limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests from this IP. Please try again later.'
    }
  }
});

// Stricter rate limiter for Gemini AI endpoints
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'AI_RATE_LIMITED',
      message: 'AI evaluation rate limit reached. Please wait a few minutes before continuing.'
    }
  }
});

app.use('/api', generalLimiter);
app.use('/api/generate-question', aiLimiter);
app.use('/api/evaluate-answer', aiLimiter);
app.use('/api/generate-report', aiLimiter);

// Privacy-safe request logger (logs method, path, status, duration — never request body or student content)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });
  next();
});

// API Routes
app.use('/api', vivaRoutes);

// 404 & Error handling
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, HOST, () => {
  console.log(`AI Viva Examiner backend listening on http://${HOST}:${PORT} (${isProd ? 'production' : 'development'})`);
});
