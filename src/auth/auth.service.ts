import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { env } from '../config/env.js';
import { generateToken, sha256Hex } from '../lib/crypto.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { redis, rk } from '../lib/redis.js';
import { decField } from '../lib/security.js';
import { audit } from '../services/audit.js';
import { signJwt } from './jwt.js';
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from './password.js';
import { verifyTotp } from './totp.js';

export const JWT_ISS = 'nexuswa';
export const JWT_AUD = 'nexuswa-dashboard';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessExpiresIn: number;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client' | 'agent';
  maxInstances: number;
  totpEnabled: boolean;
}

export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  maxInstances: u.maxInstances,
  totpEnabled: u.totpEnabled,
});

export const sessionVersion = (u: Pick<User, 'passwordChangedAt'>) => Math.floor(u.passwordChangedAt.getTime() / 1000);

async function issue(user: User, ctx: { ip: string; ua: string }, familyId?: string): Promise<IssuedSession> {
  const ttlSec = env.ACCESS_TOKEN_TTL_MIN * 60;
  const accessToken = signJwt({ sub: user.id, role: user.role, sv: sessionVersion(user), iss: JWT_ISS, aud: JWT_AUD }, env.JWT_SECRET, ttlSec);
  const refreshToken = generateToken('nwr', 48);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(refreshToken),
      familyId: familyId ?? crypto.randomUUID(),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
      ip: ctx.ip.slice(0, 64),
      userAgent: ctx.ua.slice(0, 256),
    },
  });
  return {
    accessToken,
    refreshToken,
    csrfToken: crypto.randomBytes(24).toString('base64url'),
    accessExpiresIn: ttlSec,
    user: toPublicUser(user),
  };
}

/** Bloqueio progressivo (senha OU 2FA errados): dobra a cada ciclo de falhas, limitado a 24h. */
async function registerFailure(userId: string, previous: number): Promise<{ failed: number; lock: boolean }> {
  const failed = previous + 1;
  const lock = failed % env.LOGIN_MAX_ATTEMPTS === 0;
  const cycles = Math.floor(failed / env.LOGIN_MAX_ATTEMPTS);
  const minutes = Math.min(env.LOGIN_LOCK_MINUTES * 2 ** Math.max(0, cycles - 1), 1440);
  await prisma.user.update({
    where: { id: userId },
    data: { failedLogins: failed, ...(lock ? { lockedUntil: new Date(Date.now() + minutes * 60_000) } : {}) },
  });
  return { failed, lock };
}

/**
 * Login com proteção contra brute force por conta (bloqueio temporário progressivo)
 * e contra enumeração de usuários (mesma mensagem e mesmo custo de CPU para
 * "usuário não existe" e "senha errada").
 */
export async function login(input: { email: string; password: string; otp?: string }, ctx: { ip: string; ua: string; requestId: string }): Promise<IssuedSession> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  const generic = unauthorized('E-mail ou senha inválidos');

  if (!user || !user.isActive) {
    await burnPasswordCheck(input.password);
    await audit({ actorType: 'anonymous', action: 'auth.login.failed', ip: ctx.ip, requestId: ctx.requestId, metadata: { reason: 'unknown_or_inactive' } });
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordCheck(input.password);
    throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente mais tarde.', 'account_locked');
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const { failed, lock } = await registerFailure(user.id, user.failedLogins);
    await audit({ actorType: 'user', actorId: user.id, action: 'auth.login.failed', ip: ctx.ip, requestId: ctx.requestId, metadata: { failed, locked: lock } });
    throw generic;
  }

  if (user.totpEnabled) {
    if (!input.otp) throw new HttpError(401, 'Código de verificação (2FA) obrigatório', 'otp_required');
    const secret = decField(user.totpSecretEnc, `totp:${user.id}`);
    // Anti-replay: o mesmo código não pode ser usado duas vezes na janela de validade.
    const fresh = verifyTotp(secret, input.otp) && (await redis.set(rk('totp', user.id, input.otp), '1', 'EX', 90, 'NX')) === 'OK';
    if (!fresh) {
      await registerFailure(user.id, user.failedLogins);
      await audit({ actorType: 'user', actorId: user.id, action: 'auth.otp.failed', ip: ctx.ip, requestId: ctx.requestId });
      throw new HttpError(401, 'Código de verificação inválido', 'otp_invalid');
    }
  }

  const data: { failedLogins: number; lockedUntil: null; lastLoginAt: Date; passwordHash?: string } = {
    failedLogins: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
  };
  if (needsRehash(user.passwordHash)) data.passwordHash = await hashPassword(input.password);
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  await audit({ actorType: 'user', actorId: user.id, action: 'auth.login.success', ip: ctx.ip, requestId: ctx.requestId });
  return issue(updated, ctx);
}

/**
 * Rotação de refresh token com detecção de reuso.
 * Se um token já utilizado for apresentado de novo, assume-se roubo: toda a família
 * de sessões é revogada e o usuário precisa logar novamente.
 */
export async function refresh(rawToken: string, ctx: { ip: string; ua: string; requestId: string }): Promise<IssuedSession> {
  const tokenHash = sha256Hex(rawToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!row) throw unauthorized('Sessão inválida');

  if (row.revokedAt) {
    // Duas abas renovando ao mesmo tempo: o token acabou de ser rotacionado pela outra.
    // Dentro de 30s tratamos como corrida legítima (409) e não como roubo.
    if (row.replacedBy && Date.now() - row.revokedAt.getTime() < 30_000) {
      throw new HttpError(409, 'Sessão sendo renovada em outra aba; tente novamente', 'refresh_race');
    }
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actorType: 'user', actorId: row.userId, action: 'auth.refresh.reuse_detected', ip: ctx.ip, requestId: ctx.requestId });
    throw unauthorized('Sessão revogada');
  }
  if (row.expiresAt < new Date() || !row.user.isActive) throw unauthorized('Sessão expirada');

  // Transação garante que dois refresh simultâneos com o mesmo token não gerem duas sessões.
  const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (claimed.count !== 1) throw unauthorized('Sessão já utilizada');
  const next = await issue(row.user, ctx, row.familyId);
  await prisma.refreshToken.update({ where: { id: row.id }, data: { replacedBy: sha256Hex(next.refreshToken) } });
  return next;
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
  if (row) await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
