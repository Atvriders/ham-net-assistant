import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().default('file:./dev.db'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be >= 16 chars'),
  REGISTRATION_CODE: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STATIC_DIR: z.string().default(''),
});

export const env = Env.parse(process.env);
