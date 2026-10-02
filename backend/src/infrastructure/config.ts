import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AI_GATEWAY_BASE_URL: z.string().url().optional(),
  AI_GATEWAY_MODEL: z.string().min(1).optional(),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  AI_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).optional(),
  FILE_ENCRYPTION_KEY: z.union([z.literal(''), z.string().regex(/^[a-fA-F0-9]{64}$/)]).optional().transform((value) => value || undefined),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const loadConfig = () => envSchema.parse(process.env);
