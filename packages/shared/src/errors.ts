import { z } from 'zod';

export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  // Distinct from FORBIDDEN so the client can tell "you may not do this" from
  // "you did this too fast" — the first is permanent and the second resolves
  // by waiting, and telling an operator the wrong one mid-net is worse than
  // saying nothing.
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
