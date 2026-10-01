import { createHash, randomBytes } from 'node:crypto';
import type { AuthRepository, AuditRepository } from '../application/ports.js';
import { HttpError } from '../domain/errors.js';
import type { AuthenticatedUser, UserIdentity } from '../domain/types.js';
import { hashPassword, verifyPassword } from './password.js';

export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const DUMMY_PASSWORD_HASH = 'scrypt$4f7b3c2d1a8e9f6051728394a6b7c8d9$deaa46bd43e8353529da2e1656b5045a9aa101facf6bb63c9ad0580f0d68af23eab80cb5be8f8dce1ba3f6e5852b08076c5ec739333767cb044bdf50acc37d48';

export class SessionService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly audit: AuditRepository,
    private readonly ttlHours: number,
  ) {}

  async login(email: string, password: string): Promise<{ token: string; expiresAt: string; user: { id: string; email: string; role: 'USER' | 'ADMIN' } }> {
    const user = await this.auth.findUserByEmail(email.toLowerCase());
    const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      await this.audit.writeAudit({ actorUserId: null, action: 'SESSION_LOGIN_FAILED', resourceType: 'session', resourceId: null, details: { code: 'INVALID_CREDENTIALS' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlHours * 60 * 60 * 1000);
    await this.auth.createSession(user.id, hashSessionToken(token), expiresAt);
    return { token, expiresAt: expiresAt.toISOString(), user: { id: user.id, email: user.email, role: user.role } };
  }

  async authenticate(token: string): Promise<AuthenticatedUser | null> {
    return this.auth.findSessionByTokenHash(hashSessionToken(token), new Date());
  }

  async issueWebSocketTicket(user: AuthenticatedUser): Promise<{ ticket: string; expiresAt: string }> {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60_000);
    await this.auth.createWebSocketTicket(user.id, hashSessionToken(ticket), expiresAt);
    return { ticket, expiresAt: expiresAt.toISOString() };
  }

  async consumeWebSocketTicket(ticket: string): Promise<UserIdentity | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    return this.auth.consumeWebSocketTicket(hashSessionToken(ticket), new Date());
  }

  async logout(user: AuthenticatedUser): Promise<void> {
    await this.auth.revokeSession(user.sessionId);
  }

  static async createPasswordHash(password: string): Promise<string> {
    return hashPassword(password);
  }
}
