import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { hashSessionToken, SessionService } from '../src/auth/session-service.js';
import { HttpError } from '../src/domain/errors.js';
import type { AuthRepository, AuditRepository } from '../src/application/ports.js';

const validUser = {
  id: 'user-1', email: 'admin@example.test', role: 'ADMIN' as const,
  passwordHash: 'pending',
};

class FakeAuth {
  user: typeof validUser | null = validUser;
  createdSession: { userId: string; tokenHash: string; expiresAt: Date } | null = null;
  createdWebSocketTicket: { userId: string; tokenHash: string; expiresAt: Date } | null = null;
  websocketTicketConsumed = false;
  async findUserByEmail() { return this.user; }
  async createSession(userId: string, tokenHash: string, expiresAt: Date) { this.createdSession = { userId, tokenHash, expiresAt }; }
  async createWebSocketTicket(userId: string, tokenHash: string, expiresAt: Date) { this.createdWebSocketTicket = { userId, tokenHash, expiresAt }; }
  async consumeWebSocketTicket(tokenHash: string, now: Date) {
    if (!this.createdWebSocketTicket || this.websocketTicketConsumed || this.createdWebSocketTicket.tokenHash !== tokenHash || this.createdWebSocketTicket.expiresAt <= now) return null;
    this.websocketTicketConsumed = true;
    return { id: validUser.id, email: validUser.email, role: validUser.role, sessionId: 'ticket-id' };
  }
  async revokeSession() {}
}

class FakeAudit {
  events: string[] = [];
  async writeAudit(input: { action: string }) { this.events.push(input.action); }
}

test('passwords are salted scrypt digests and verify without storing plaintext', async () => {
  const password = 'a-long-test-password-value';
  const encoded = await hashPassword(password);
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('incorrect-password', encoded), false);
});

test('login returns a random bearer token while only persisting its digest', async () => {
  const auth = new FakeAuth();
  auth.user = { ...validUser, passwordHash: await hashPassword('correct-test-password') };
  const audit = new FakeAudit();
  const service = new SessionService(auth as unknown as AuthRepository, audit as unknown as AuditRepository, 24);
  const session = await service.login('ADMIN@example.test', 'correct-test-password');
  assert.equal(session.user.id, validUser.id);
  assert.equal(session.user.role, 'ADMIN');
  assert.equal(session.token.length >= 40, true);
  assert.deepEqual(auth.createdSession && {
    userId: auth.createdSession.userId,
    tokenHash: auth.createdSession.tokenHash,
  }, { userId: validUser.id, tokenHash: hashSessionToken(session.token) });
  assert.notEqual(auth.createdSession?.tokenHash, session.token);
});

test('WebSocket tickets are short-lived, hashed at rest, and consumed once', async () => {
  const auth = new FakeAuth();
  const service = new SessionService(auth as unknown as AuthRepository, new FakeAudit() as unknown as AuditRepository, 24);
  const user = { id: validUser.id, email: validUser.email, role: validUser.role, sessionId: 'session-1' };
  const issued = await service.issueWebSocketTicket(user);
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.createdWebSocketTicket?.tokenHash, issued.ticket);
  assert.equal(auth.createdWebSocketTicket?.tokenHash, hashSessionToken(issued.ticket));
  assert.ok(new Date(issued.expiresAt).getTime() <= Date.now() + 60_000);
  assert.equal((await service.consumeWebSocketTicket(issued.ticket))?.id, validUser.id);
  assert.equal(await service.consumeWebSocketTicket(issued.ticket), null);
  assert.equal(await service.consumeWebSocketTicket('short'), null);
});

test('invalid credentials use a generic error and are audit logged', async () => {
  const auth = new FakeAuth(); auth.user = null;
  const audit = new FakeAudit();
  const service = new SessionService(auth as unknown as AuthRepository, audit as unknown as AuditRepository, 24);
  await assert.rejects(() => service.login('missing@example.test', 'incorrect-password'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, 'INVALID_CREDENTIALS');
    return true;
  });
  assert.deepEqual(audit.events, ['SESSION_LOGIN_FAILED']);
});
