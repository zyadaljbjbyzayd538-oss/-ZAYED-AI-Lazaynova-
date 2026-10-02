import { URL } from 'node:url';

export function redisConnectionFromUrl(redisUrl = process.env.REDIS_URL): { host: string; port: number; username?: string; password?: string; tls?: Record<string, never>; maxRetriesPerRequest: null } {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('REDIS_URL must use redis:// or rediss://');
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
