import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import vivaRoutes from './routes/vivaRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');

function isLocalhostOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

/**
 * Creates and configures the Express application.
 * Exported separately from server startup so tests can run cleanly without port collisions.
 */
export function createApp({ enableRateLimit = process.env.NODE_ENV !== 'test' } = {}) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  // Trust reverse proxy (required on Render for accurate rate limiting & HTTPS headers)
  app.set('trust proxy', 1);

  // Security HTTP headers configured to allow CDN extraction scripts, fonts, and configurable backend APIs
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
          workerSrc: ["'self'", 'blob:', 'https://cdnjs.cloudflare.com'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'http://localhost:*', 'http://127.0.0.1:*', 'https:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"]
        }
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  // Parse explicit allowed frontend origins from environment
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  app.use(
    cors((req, callback) => {
      const origin = req.header('Origin');
      // Allow non-browser tools (curl, health checks) and same-origin GETs with no Origin header
      if (!origin) {
        return callback(null, { origin: true });
      }

      const normalizedOrigin = origin.replace(/\/+$/, '');
      const host = req.header('Host');
      const sameOriginHttp = host ? [`http://${host}`, `https://${host}`] : [];

      if (
        sameOriginHttp.includes(normalizedOrigin) ||
        allowedOrigins.includes(normalizedOrigin) ||
        (!isProd && isLocalhostOrigin(normalizedOrigin))
      ) {
        return callback(null, {
          origin: true,
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Content-Type'],
          maxAge: 86400
        });
      }

      return callback(new Error(`CORS: Origin ${normalizedOrigin} is not allowed.`));
    })
  );

  // Request body size limit (covers up to 40,000 multibyte UTF-8 characters + answers)
  app.use(express.json({ limit: '300kb' }));

  if (enableRateLimit) {
    // Global rate limiter for API routes
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
  }

  // Privacy-safe request logger (logs method, path, status, duration — never request body or student content)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      if (process.env.NODE_ENV !== 'test') {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
      }
    });
    next();
  });

  // API Routes
  app.use('/api', vivaRoutes);

  // Serve frontend static assets cleanly without ever exposing backend/ or .env
  const indexHtmlPath = path.join(FRONTEND_ROOT, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    app.use('/css', express.static(path.join(FRONTEND_ROOT, 'css')));
    app.use('/js', express.static(path.join(FRONTEND_ROOT, 'js')));
    app.use('/assets', express.static(path.join(FRONTEND_ROOT, 'assets')));

    app.get(['/', '/index.html'], (_req, res) => {
      res.sendFile(indexHtmlPath);
    });

    app.get('/favicon.ico', (_req, res) => {
      res.status(204).end();
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'ai-viva-examiner-backend',
        health: '/api/health'
      });
    });
  }

  // 404 & Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
