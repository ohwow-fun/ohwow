/**
 * Minimal Onboarding Server
 * Lightweight Express server that serves only the web UI SPA,
 * health endpoint, and onboarding API routes.
 * Used when the user chooses "Set up in your browser" from the TUI.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import express from 'express';
import cors from 'cors';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { createHealthRouter } from './routes/health.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface OnboardingServerHandle {
  port: number;
  sessionToken: string;
  server: Server;
  shutdown: () => void;
}

/**
 * Start a minimal server for web-based onboarding.
 * Only serves: health, onboarding API, and the static web UI SPA.
 */
export async function startOnboardingServer(
  db: DatabaseAdapter,
  rawDb: Database.Database,
  port: number,
): Promise<OnboardingServerHandle> {
  const app = express();
  const sessionToken = randomUUID();
  const startTime = Date.now();

  // CORS
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  app.use(express.json());

  // Public routes (no auth needed for onboarding)
  app.use(createHealthRouter(startTime, rawDb));
  app.use(createOnboardingRouter(db));

  // Session endpoint so the web UI can authenticate after onboarding
  app.get('/api/session', (_req, res) => {
    res.json({ data: { valid: true, token: sessionToken } });
  });

  // Serve static web UI SPA
  const distPaths = [
    join(__dirname, '..', 'web', 'dist'),
    join(__dirname, '..', '..', 'src', 'web', 'dist'),
  ];
  const webDist = distPaths.find(p => existsSync(p));
  if (webDist) {
    app.use('/ui', express.static(webDist));
    app.get('/ui/*', (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  // Start listening
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`Onboarding server started on port ${port}`);
      resolve({
        port,
        sessionToken,
        server,
        shutdown: () => {
          server.close();
          logger.info('Onboarding server stopped');
        },
      });
    });
    server.on('error', (err) => {
      reject(err);
    });
  });
}
