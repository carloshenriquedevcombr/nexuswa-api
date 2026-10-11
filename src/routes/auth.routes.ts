import { Router, type Response } from 'express';
import { z } from 'zod';
import { login, logout, refresh, revokeAllSessions, toPublicUser, type IssuedSession } from '../auth/auth.service.js';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../auth/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { env } from '../config/env.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { decField, encField } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, requireUser } from '../middlewares/auth.js';
import { loginLimiter, refreshLimiter, sensitiveLimiter } from '../middlewares/rateLimit.js';
import { audit } from '../services/audit.js';

export const authRouter = Router();

/**
 * Cookies de sessão:
 *  - access  (HttpOnly, SameSite=Strict, vida curta)  → inacessível a JS: XSS não rouba sessão
 *  - refresh (HttpOnly, SameSite=Strict, path /auth)   → só trafega nas rotas de renovação
 *  - csrf    (legível por JS, SameSite=Strict)         → double-submit no header X-CSRF-Token
 */
function setSessionCookies(res: Response, s: IssuedSession): void {
  const base = { secure: env.COOKIE_SECURE, sameSite: 'strict' as const, ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}) };
  res.cookie(ACCESS_COOKIE, s.accessToken, { ...base, httpOnly: true, path: '/', maxAge: s.accessExpiresIn * 1000 });
  res.cookie(REFRESH_COOKIE, s.refreshToken, { ...base, httpOnly: true, path: '/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
  res.cookie(CSRF_COOKIE, s.csrfToken, { ...base, httpOnly: false, path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
}

function clearSessionCookies(res: Response): void {
  const base = { secure: env.COOKIE_SECURE, sameSite: 'strict' as const, ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}) };
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/auth' });
  res.clearCookie(CSRF_COOKIE, { ...base, path: '/' });
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(256),
  otp: z.string().regex(/^\d{6}$/).optional(),
});

authRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const body = parse(credentials, req.body);
  const session = await login(body, { ip: req.ip ?? '', ua: String(req.headers['user-agent'] ?? ''), requestId: req.id });
  setSessionCookies(res, session);
  // Tokens também no corpo para clientes não-navegador (CLI, apps). Navegadores devem usar só os cookies.
  res.json({ user: session.user, accessToken: session.accessToken, refreshToken: session.refreshToken, csrfToken: session.csrfToken, expiresIn: session.accessExpiresIn });
});

authRouter.post('/auth/refresh', refreshLimiter, async (req, res) => {
  const raw = (req.cookies as Record<string, string>)[REFRESH_COOKIE] ?? parse(z.object({ refreshToken: z.string().max(200).optional() }), req.body).refreshToken;
  if (!raw) throw unauthorized('Sessão ausente');
  const session = await refresh(raw, { ip: req.ip ?? '', ua: String(req.headers['user-agent'] ?? ''), requestId: req.id });
  setSessionCookies(res, session);
  res.json({ user: session.user, accessToken: session.accessToken, refreshToken: session.refreshToken, csrfToken: session.csrfToken, expiresIn: session.accessExpiresIn });
});

authRouter.post('/auth/logout', async (req, res) => {
  const raw = (req.cookies as Record<string, string>)[REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken;
  await logout(typeof raw === 'string' ? raw : undefined);
  clearSessionCookies(res);
  res.json({ response: 'Logged out' });
});

authRouter.get('/auth/me', requireUser, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth.user!.id } });
  res.json({ user: toPublicUser(user) });
});

authRouter.post('/auth/password', requireUser, sensitiveLimiter, async (req, res) => {
  const p = parse(z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth.user!.id } });
  if (!(await verifyPassword(user.passwordHash, p.currentPassword))) throw unauthorized('Senha atual incorreta');
  const policy = validatePasswordPolicy(p.newPassword, user.email);
  if (policy) throw badRequest(policy);
  // passwordChangedAt invalida todos os access tokens anteriores (claim sv).
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(p.newPassword), passwordChangedAt: new Date() } });
  await revokeAllSessions(user.id);
  await audit({ actorType: 'user', actorId: user.id, action: 'auth.password.change', ip: req.ip, requestId: req.id });
  clearSessionCookies(res);
  res.json({ response: 'Senha alterada. Faça login novamente.' });
});

authRouter.post('/auth/2fa/setup', requireUser, sensitiveLimiter, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth.user!.id } });
  if (user.totpEnabled) throw badRequest('2FA já está ativo');
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: encField(secret, `totp:${user.id}`) } });
  res.json({ secret, otpauth_url: otpauthUrl(secret, user.email), info: 'Escaneie no app autenticador e confirme em /auth/2fa/enable' });
});

authRouter.post('/auth/2fa/enable', requireUser, sensitiveLimiter, async (req, res) => {
  const { otp } = parse(z.object({ otp: z.string().regex(/^\d{6}$/) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth.user!.id } });
  const secret = decField(user.totpSecretEnc, `totp:${user.id}`);
  if (!secret || !verifyTotp(secret, otp)) throw badRequest('Código inválido');
  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
  await audit({ actorType: 'user', actorId: user.id, action: 'auth.2fa.enable', ip: req.ip, requestId: req.id });
  res.json({ response: '2FA ativado' });
});

authRouter.post('/auth/2fa/disable', requireUser, sensitiveLimiter, async (req, res) => {
  const p = parse(z.object({ password: z.string().max(256), otp: z.string().regex(/^\d{6}$/) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth.user!.id } });
  const secret = decField(user.totpSecretEnc, `totp:${user.id}`);
  if (!(await verifyPassword(user.passwordHash, p.password)) || !secret || !verifyTotp(secret, p.otp)) throw unauthorized('Credenciais inválidas');
  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecretEnc: null } });
  await audit({ actorType: 'user', actorId: user.id, action: 'auth.2fa.disable', ip: req.ip, requestId: req.id });
  res.json({ response: '2FA desativado' });
});
