import { createPool, PostgresRepositories } from '../infrastructure/postgres.js';
import { SessionService } from '../auth/session-service.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password || password.length < 14) {
  throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 14 characters.');
}

const pool = createPool();
try {
  const existing = await pool.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
  if (existing.rowCount) throw new Error('An admin already exists; bootstrap is intentionally one-time.');
  const repositories = new PostgresRepositories(pool);
  const hash = await SessionService.createPasswordHash(password);
  const userId = await repositories.createUser(email, hash, 'ADMIN');
  await repositories.writeAudit({ actorUserId: userId, action: 'ADMIN_BOOTSTRAPPED', resourceType: 'user', resourceId: userId, details: {} });
  console.info(`Created bootstrap administrator ${email} (id: ${userId}). Sign in, then assign explicit capability grants through the admin API.`);
} finally {
  await pool.end();
}
