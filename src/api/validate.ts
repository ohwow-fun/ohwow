/**
 * Zod validation middleware factory for Express routes.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const messages = result.error.issues.map((issue: z.core.$ZodIssue) =>
        `${issue.path.join('.')}: ${issue.message}`,
      );
      res.status(400).json({ error: 'Validation failed', details: messages });
      return;
    }
    req.body = result.data;
    next();
  };
}
