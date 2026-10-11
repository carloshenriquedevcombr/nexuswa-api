import { Router } from 'express';
import { z } from 'zod';
import { revokeAllSessions, toPublicUser } from '../auth/auth.service.js';
import { hashPassword, validatePasswordPolicy } from '../auth/password.js';
import { verifyTotp } from '../auth/totp.js';
import { env } from '../config/env.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { redis, rk } from '../lib/redis.js';
import { decField } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { requireRole, requireServerAdmin } from '../middlewares/auth.js';
import { sensitiveLimiter } from '../middlewares/rateLimit.js';
import { drainQueue, invalidateAgents } from '../services/agentRouter.js';
import { audit } from '../services/audit.js';
import { SessionManager } from '../whatsapp/SessionManager.js';

const startedAt = Date.now();

/** Gestão de usuários/tenants, auditoria, bug reports e operações de servidor. */
export const adminRouter = Router();
const adminOnly = requireRole('admin');

// ---------- Usuários (somente admin humano) ----------
adminRouter.get('/users', adminOnly, async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { instances: true } } } });
  res.json(users.map((u) => ({ ...toPublicUser(u), isActive: u.isActive, instances: u._count.instances, lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil, createdAt: u.createdAt })));
});

adminRouter.post('/users', adminOnly, sensitiveLimiter, async (req, res) => {
  const p = parse(
    z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      name: z.string().trim().max(200).default(''),
      password: z.string().max(256),
      role: z.enum(['admin', 'client']).default('client'),
      maxInstances: z.coerce.number().int().min(0).max(1000).default(1),
    }),
    req.body,
  );
  const policy = validatePasswordPolicy(p.password, p.email);
  if (policy) throw badRequest(policy);
  if (await prisma.user.findUnique({ where: { email: p.email } })) throw conflict('E-mail já cadastrado');
  const user = await prisma.user.create({ data: { email: p.email, name: p.name, role: p.role, maxInstances: p.maxInstances, passwordHash: await hashPassword(p.password) } });
  await audit({ actorType: 'user', actorId: req.auth.user!.id, action: 'user.create', targetType: 'user', targetId: user.id, ip: req.ip, requestId: req.id, metadata: { role: p.role } });
  res.status(201).json(toPublicUser(user));
});

adminRouter.patch('/users/:id', adminOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const p = parse(
    z.object({ name: z.string().max(200).optional(), role: z.enum(['admin', 'client']).optional(), maxInstances: z.coerce.number().int().min(0).max(1000).optional(), isActive: z.boolean().optional(), password: z.string().max(256).optional(), unlock: z.boolean().optional() }),
    req.body,
  );
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound('Usuário não encontrado');
  if (id === req.auth.user!.id && (p.role === 'client' || p.isActive === false)) throw badRequest('Você não pode rebaixar ou desativar a própria conta');
  let passwordHash: string | undefined;
  if (p.password) {
    const policy = validatePasswordPolicy(p.password, user.email);
    if (policy) throw badRequest(policy);
    passwordHash = await hashPassword(p.password);
  }
  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.role ? { role: p.role } : {}),
      ...(p.maxInstances !== undefined ? { maxInstances: p.maxInstances } : {}),
      ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
      ...(passwordHash ? { passwordHash, passwordChangedAt: new Date() } : {}),
      ...(p.unlock ? { failedLogins: 0, lockedUntil: null } : {}),
    },
  });
  if (passwordHash || p.isActive === false || p.role) await revokeAllSessions(id);
  await audit({ actorType: 'user', actorId: req.auth.user!.id, action: 'user.update', targetType: 'user', targetId: id, ip: req.ip, requestId: req.id, metadata: { fields: Object.keys(p).filter((k) => k !== 'password') } });
  res.json(toPublicUser(updated));
});

adminRouter.delete('/users/:id', adminOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (id === req.auth.user!.id) throw badRequest('Você não pode excluir a própria conta');
  // Instâncias ficam sem dono (SetNull) em vez de sumirem — evita perda acidental de sessões.
  await prisma.user.delete({ where: { id } }).catch(() => {
    throw notFound('Usuário não encontrado');
  });
  await audit({ actorType: 'user', actorId: req.auth.user!.id, action: 'user.delete', targetType: 'user', targetId: id, ip: req.ip, requestId: req.id });
  res.json({ response: 'Usuário removido' });
});

adminRouter.post('/instance/assign', adminOnly, async (req, res) => {
  const p = parse(z.object({ instance_id: z.string().uuid(), user_id: z.string().uuid().nullable() }), req.body);
  await prisma.instance.update({ where: { id: p.instance_id }, data: { ownerId: p.user_id } }).catch(() => {
    throw notFound('Instância não encontrada');
  });
  // Novo dono: atendentes da equipe anterior perdem o acesso a este número e às conversas dele.
  const foreign = await prisma.instanceAgent.findMany({ where: { instanceId: p.instance_id, user: p.user_id ? { OR: [{ ownerUserId: null }, { ownerUserId: { not: p.user_id } }] } : { ownerUserId: { not: null } } }, select: { id: true, userId: true } });
  if (foreign.length) {
    const ids: string[] = foreign.map((f: { userId: string }) => f.userId);
    await prisma.$transaction([
      prisma.chat.updateMany({ where: { instanceId: p.instance_id, leadAssignedAttendantId: { in: ids } }, data: { leadAssignedAttendantId: '' } }),
      prisma.instanceAgent.deleteMany({ where: { id: { in: foreign.map((f) => f.id) } } }),
    ]);
    // Mesmo tratamento do DELETE /agents: quem ficou sem nenhum número perde o login.
    for (const userId of new Set(ids)) {
      if (!(await prisma.instanceAgent.count({ where: { userId } }))) {
        await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
        await revokeAllSessions(userId);
      }
    }
    invalidateAgents(p.instance_id);
    void drainQueue(p.instance_id).catch(() => undefined);
  }
  await audit({ actorType: 'user', actorId: req.auth.user!.id, action: 'instance.assign', targetType: 'instance', targetId: p.instance_id, ip: req.ip, requestId: req.id, metadata: { to: p.user_id } });
  res.json({ response: 'Instância atribuída' });
});

// ---------- Auditoria e bugs ----------
adminRouter.get('/admin/audit', adminOnly, async (req, res) => {
  const p = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0), action: z.string().max(100).optional() }), req.query);
  const rows = await prisma.auditLog.findMany({ where: p.action ? { action: { startsWith: p.action } } : {}, orderBy: { createdAt: 'desc' }, skip: p.offset, take: p.limit });
  res.json(rows);
});

adminRouter.get('/admin/bug-reports', adminOnly, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const rows = await prisma.bugReport.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 500, include: { user: { select: { email: true, name: true } } } });
  res.json(rows.map(({ user, ...r }) => ({ ...r, user_email: user?.email ?? '', user_name: user?.name ?? '' })));
});

adminRouter.patch('/admin/bug-reports/:id', adminOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { status } = parse(z.object({ status: z.enum(['open', 'triaged', 'fixed', 'wontfix']) }), req.body);
  res.json(await prisma.bugReport.update({ where: { id }, data: { status } }));
});

// ---------- Servidor (compatível uazapi) ----------
/** Equivalente ao GET /status da uazapi — restrito a admin (contagem de tenants é informação sensível). */
adminRouter.get('/status', requireServerAdmin, async (_req, res) => {
  const [total, connected, disconnected] = await Promise.all([
    prisma.instance.count(),
    prisma.instance.count({ where: { status: 'connected' } }),
    prisma.instance.count({ where: { status: 'disconnected' } }),
  ]);
  res.json({
    info: 'NexusWA',
    instance_counts: { total, connected, disconnected, connecting: total - connected - disconnected, observed_at: new Date().toISOString() },
    status: { server_status: 'running', uptime_s: Math.round((Date.now() - startedAt) / 1000), node_sessions: SessionManager.counts() },
  });
});


adminRouter.post('/admin/restart', requireServerAdmin, sensitiveLimiter, async (req, res) => {
  await audit({ actorType: req.auth.adminToken ? 'admintoken' : 'user', actorId: req.auth.user?.id ?? 'admintoken', action: 'server.restart', ip: req.ip, requestId: req.id });
  res.json({ message: 'Reinício solicitado; o orquestrador (Docker) reinicia o processo.' });
  // SIGTERM → shutdown gracioso (sessões preservadas) → Docker "restart: unless-stopped" sobe de novo.
  setTimeout(() => {
    logger.warn('reinício solicitado via /admin/restart');
    process.kill(process.pid, 'SIGTERM');
  }, 500);
});

/**
 * Mostra o admintoken no painel SÓ para admin humano com 2FA ativo, digitando um código
 * novo (anti-replay: o mesmo código não vale duas vezes). Cada visualização é auditada.
 * Por quê não mostrar sempre: é a chave-mestra do servidor; uma sessão esquecida aberta
 * não pode bastar para copiá-la.
 */
adminRouter.post('/admin/token/reveal', adminOnly, sensitiveLimiter, async (req, res) => {
  const { otp } = parse(z.object({ otp: z.string().regex(/^\d{6}$/, 'código de 6 dígitos') }), req.body);
  const user = await prisma.user.findUnique({ where: { id: req.auth.user!.id } });
  if (!user?.totpEnabled || !user.totpSecretEnc) throw badRequest('Ative a verificação em duas etapas (2FA) em "Minha conta" para poder ver o Admin Token');
  const secret = decField(user.totpSecretEnc, `totp:${user.id}`);
  const fresh = verifyTotp(secret, otp) && (await redis.set(rk('totp', user.id, otp), '1', 'EX', 90, 'NX')) === 'OK';
  if (!fresh) {
    await audit({ actorType: 'user', actorId: user.id, action: 'admin.token.reveal.failed', ip: req.ip, requestId: req.id });
    throw unauthorized('Código de verificação inválido');
  }
  await audit({ actorType: 'user', actorId: user.id, action: 'admin.token.reveal', ip: req.ip, requestId: req.id });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ admin_token: env.ADMIN_TOKEN, visible_for_seconds: 60 });
});

adminRouter.post('/admin/token/rotate', requireServerAdmin, (_req, res) => {
  // O admintoken vive no .env (fora do banco, por design). Rotacionar pela API exigiria
  // gravá-lo em local acessível ao processo — o que ampliaria a superfície de ataque.
  res.status(501).json({
    error: 'Rotacione o admintoken trocando ADMIN_TOKEN no .env e reiniciando o container (npm run secrets:generate gera um novo valor).',
    error_key: 'rotate_via_env',
  });
});
