import type { RequestHandler } from 'express';
import type { z } from 'zod';

export function validateBody<T>(schema: z.ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    // Express 5 leaves req.body undefined when no body was parsed (v4 set
    // {}); default it so empty-body requests still fail schema validation
    // with a 400 rather than a TypeError.
    const parsed = schema.parse(req.body ?? {});
    req.body = parsed;
    next();
  };
}
