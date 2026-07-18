import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so thrown errors / rejected promises are
 * forwarded to Express's error middleware. (Express 5 does this natively,
 * but the wrapper stays: it also pins the params type below.)
 *
 * Params typing: @types/express 5 widened ParamsDictionary values to
 * `string | string[]` (arrays only occur for repeated/wildcard segments).
 * Every route in this app uses plain `:name` segments, where Express always
 * produces a single string — so handlers see Record<string, string> and the
 * one cast lives here instead of at every `req.params.id` read.
 */
type ParamsRequest = Request<Record<string, string>>;

export function asyncHandler(
  fn: (req: ParamsRequest, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as ParamsRequest, res, next)).catch(next);
  };
}
