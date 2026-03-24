/**
 * Async route handler wrapper and global error middleware.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Wraps async route handlers so thrown errors reach the error middleware
 * instead of becoming unhandled promise rejections.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Express error middleware (4-arg signature).
 * Must be registered after all routes.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, '[API] Unhandled error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
