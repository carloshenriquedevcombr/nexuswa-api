import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { revokeAllSessions } from '../auth/auth.service.js';
import { hashPassword, validatePasswordPolicy } from '../auth/password.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parse } from '../lib/validate.js';
import { inst, requireUser } from '../middlewares/auth.js';
import { assertAssigned } from '../middlewares/agentScope.js';
import { sensitiveLimiter } from '../middlewares/rateLimit.js';
import { availabilityLabel, drainQueue, invalidateAgents, isAvailable, requeueAgentChats } from '../services/agentRouter.js';
import { audit } from '../services/audit.js';
import { eventBus } from '../whatsapp/eventBus.js';
import { onlineAgents } from '../services/sse.js';

/**
 * Atendimento multiusuário.
 *  - /agents/*  → o DONO do número (ou admin / token da instância) cadastra e gerencia atendentes.
 *  - /ticket/*  → dono ou atendente finaliza/transfere conversas (atendente só as dele).
 *  - /agent/*   → o próprio atendente vê seus números e marca pausa (almoço, férias).
 * Rotas /agents e /ticket passam por requireInstance (INSTANCE_SCOPED em app.ts); para
 * atendentes, /agents é bloqueado lá (lista branca em agentScope.ts).
 */
export const agentRouter = Router();

const HHMM = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM, ex.: 12:00')]);
const PAUSE_REASONS = ['almoco', 'ferias', 'outro'] as const;

function actor(req: Request) {
  return req.auth.user
    ? { actorType: 'user' as const, actorId: req.auth.user.id }
    : req.auth.adminToken
      ? { actorType: 'admintoken' as const, actorId: '' }
      : { actorType: 'instance' as const, actorId: req.auth.instance?.id ?? '' };
}

const isAdmin = (req: Request) => req.auth.adminToken || req.auth.user?.role === 'admin';

/** Leitura da equipe: dono, admin ou token da instância (integrações). */
function assertManager(req: Request): void {
  if (req.auth.agent) throw forbidden('Atendentes não gerenciam a equipe');
}

/**
 * Alterações na equipe exigem o DONO logado (ou admin). Um token de instância vazado
 * não pode criar contas nem trocar senhas de atendentes — isso daria acesso a outros
 * números do mesmo dono. Instância sem dono: só admin.
 */
function assertTeamWriter(req: Request): void {
  assertManager(req);
  if (isAdmin(req)) return;
  const ownerId = inst(req).ownerId;
  if (!ownerId || req.auth.user?.id !== ownerId) throw forbidden('Só o dono do número (logado) ou um admin altera a equipe');
}

/** O "dono" dos atendentes cadastrados neste número (a conta do cliente). */
function teamOwnerId(req: Request): string | null {
  return inst(req).ownerId ?? null;
}

async function loadAgentOfInstance(instanceId: string, userId: string) {
  const link = await prisma.instanceAgent.findUnique({ where: { instanceId_userId: { instanceId, userId } }, include: { user: true } });
  if (!link) throw notFound('Atendente não encontrado neste número');
  return link;
}

function presentLink(l: { userId: string; active: boolean; status: string; pauseReason: string; pausedUntil: Date | null; breakStart: string; breakEnd: string; lastAssignedAt: Date | null; user: { name: string; email: string; isActive: boolean; lastLoginAt: Date | null } }, openChats = 0) {
  return {
    user_id: l.userId,
    name: l.user.name,
    email: l.user.email,
    login_enabled: l.user.isActive,
    active: l.active,
    status: l.status,
    pause_reason: l.pauseReason,
    paused_until: l.pausedUntil?.toISOString() ?? null,
    break_start: l.breakStart,
    break_end: l.breakEnd,
    available: isAvailable(l),
    availability: availabilityLabel(l),
    last_assigned_at: l.lastAssignedAt?.toISOString() ?? null,
    last_login_at: l.user.lastLoginAt?.toISOString() ?? null,
    open_chats: openChats,
  };
}

// ------------------------------------------------------------------ gestão pelo dono
agentRouter.get('/agents', async (req, res) => {
  assertManager(req);
  const instanceId = inst(req).id;
  const [links, counts, queue] = await Promise.all([
    prisma.instanceAgent.findMany({ where: { instanceId }, include: { user: true }, orderBy: { createdAt: 'asc' } }),
    prisma.chat.groupBy({ by: ['leadAssignedAttendantId'], where: { instanceId, leadIsTicketOpen: true, leadAssignedAttendantId: { not: '' } }, _count: true }),
    prisma.chat.count({ where: { instanceId, leadIsTicketOpen: true, leadAssignedAttendantId: '' } }),
  ]);
  const byUser = new Map<string, number>(counts.map((c): [string, number] => [c.leadAssignedAttendantId, Number(c._count)]));
  const online = await onlineAgents(instanceId, links.map((l) => l.userId));
  res.json({ agents: links.map((l) => ({ ...presentLink(l, byUser.get(l.userId) ?? 0), online: online.has(l.userId) })), queue });
});

agentRouter.post('/agents', sensitiveLimiter, async (req, res) => {
  assertTeamWriter(req);
  const p = parse(
    z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      name: z.string().trim().max(200).optional(),
      password: z.string().max(256).optional(),
      break_start: HHMM.optional(),
      break_end: HHMM.optional(),
    }),
    req.body,
  );
  const instance = inst(req);
  const ownerId = teamOwnerId(req);
  let user = await prisma.user.findUnique({ where: { email: p.email } });
  // Mesma resposta para "e-mail de outra conta" e "faltou senha": não revela quais e-mails existem.
  const unusable = () => badRequest('Não foi possível usar este e-mail. Para um atendente novo, informe também uma senha.');
  if (user) {
    // Só reaproveita atendente da MESMA equipe — impede "sequestrar" contas de outros clientes.
    // Dono nulo nunca "combina" com dono nulo.
    if (user.role !== 'agent' || !ownerId || user.ownerUserId !== ownerId) throw unusable();
    // Readicionado pelo próprio dono: reativa o login (pode ter sido desativado ao sair do último número).
    if (!user.isActive) user = await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
  } else {
    if (!p.password) throw unusable();
    const policy = validatePasswordPolicy(p.password, p.email);
    if (policy) throw badRequest(policy);
    user = await prisma.user.create({
      data: { email: p.email, name: p.name ?? '', role: 'agent', maxInstances: 0, ownerUserId: ownerId, passwordHash: await hashPassword(p.password) },
    });
  }
  const link = await prisma.instanceAgent.upsert({
    where: { instanceId_userId: { instanceId: instance.id, userId: user.id } },
    create: { instanceId: instance.id, userId: user.id, breakStart: p.break_start ?? '', breakEnd: p.break_end ?? '' },
    update: { active: true },
    include: { user: true },
  });
  invalidateAgents(instance.id);
  await audit({ ...actor(req), action: 'agent.add', targetType: 'user', targetId: user.id, ip: req.ip, requestId: req.id, metadata: { instanceId: instance.id } });
  void drainQueue(instance.id).catch(() => undefined);
  res.status(201).json(presentLink(link));
});

agentRouter.patch('/agents/:userId', sensitiveLimiter, async (req, res) => {
  assertTeamWriter(req);
  const userId = z.string().uuid().parse(req.params.userId);
  const p = parse(
    z.object({
      name: z.string().trim().max(200).optional(),
      active: z.boolean().optional(),
      login_enabled: z.boolean().optional(),
      password: z.string().max(256).optional(),
      status: z.enum(['available', 'paused']).optional(),
      pause_reason: z.enum(PAUSE_REASONS).optional(),
      paused_until: z.string().datetime({ offset: true }).nullable().optional(),
      break_start: HHMM.optional(),
      break_end: HHMM.optional(),
    }),
    req.body,
  );
  const instance = inst(req);
  const link = await loadAgentOfInstance(instance.id, userId);
  const ownerId = teamOwnerId(req);
  const ownsAccount = isAdmin(req) || (Boolean(ownerId) && link.user.ownerUserId === ownerId);
  if ((p.password || p.name !== undefined || p.login_enabled !== undefined) && !ownsAccount) throw forbidden('Só a equipe que cadastrou o atendente altera a conta dele');

  let passwordHash: string | undefined;
  if (p.password) {
    const policy = validatePasswordPolicy(p.password, link.user.email);
    if (policy) throw badRequest(policy);
    passwordHash = await hashPassword(p.password);
  }
  if (passwordHash || p.name !== undefined || p.login_enabled !== undefined) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.login_enabled !== undefined ? { isActive: p.login_enabled } : {}),
        ...(passwordHash ? { passwordHash, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } : {}),
      },
    });
    if (passwordHash || p.login_enabled === false) await revokeAllSessions(userId);
  }
  const updated = await prisma.instanceAgent.update({
    where: { id: link.id },
    data: {
      ...(p.active !== undefined ? { active: p.active } : {}),
      ...(p.status ? { status: p.status, ...(p.status === 'available' ? { pauseReason: '', pausedUntil: null } : {}) } : {}),
      ...(p.pause_reason ? { pauseReason: p.pause_reason } : {}),
      ...(p.paused_until !== undefined ? { pausedUntil: p.paused_until ? new Date(p.paused_until) : null } : {}),
      ...(p.break_start !== undefined ? { breakStart: p.break_start } : {}),
      ...(p.break_end !== undefined ? { breakEnd: p.break_end } : {}),
    },
    include: { user: true },
  });
  invalidateAgents(instance.id);
  // Desativado: as conversas abertas dele voltam para a fila e são redistribuídas.
  // Férias = ausência longa: os clientes em aberto dele voltam para a fila e seguem com outro atendente.
  if (p.active === false || p.login_enabled === false || p.pause_reason === 'ferias') await requeueAgentChats(instance.id, userId);
  void drainQueue(instance.id).catch(() => undefined);
  await audit({ ...actor(req), action: 'agent.update', targetType: 'user', targetId: userId, ip: req.ip, requestId: req.id, metadata: { instanceId: instance.id, fields: Object.keys(p).filter((k) => k !== 'password') } });
  res.json(presentLink(updated));
});

agentRouter.delete('/agents/:userId', async (req, res) => {
  assertTeamWriter(req);
  const userId = z.string().uuid().parse(req.params.userId);
  const instance = inst(req);
  const link = await loadAgentOfInstance(instance.id, userId);
  const moved = await requeueAgentChats(instance.id, userId);
  // Conversas finalizadas também deixam de ser dele (sem acesso ao histórico após sair).
  await prisma.chat.updateMany({ where: { instanceId: instance.id, leadAssignedAttendantId: userId }, data: { leadAssignedAttendantId: '' } });
  await prisma.instanceAgent.delete({ where: { id: link.id } });
  // Sem nenhum número restante, a conta do atendente é desativada (não fica "órfã" com login).
  if (!(await prisma.instanceAgent.count({ where: { userId } }))) {
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    await revokeAllSessions(userId);
  }
  invalidateAgents(instance.id);
  void drainQueue(instance.id).catch(() => undefined);
  await audit({ ...actor(req), action: 'agent.remove', targetType: 'user', targetId: userId, ip: req.ip, requestId: req.id, metadata: { instanceId: instance.id, requeued: moved } });
  res.json({ success: true, requeued: moved });
});

agentRouter.post('/agents/drain', async (req, res) => {
  assertManager(req);
  if (!req.auth.user && !req.auth.adminToken && !req.auth.instance) throw forbidden();
  res.json({ assigned: await drainQueue(inst(req).id) });
});

// ------------------------------------------------------------------ conversas (dono ou atendente)
agentRouter.get('/ticket/agents', async (req, res) => {
  const links = await prisma.instanceAgent.findMany({ where: { instanceId: inst(req).id, active: true, user: { isActive: true } }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
  const online = await onlineAgents(inst(req).id, links.map((l) => l.userId));
  // Para o atendente, só o necessário para escolher a quem transferir (sem e-mail).
  res.json(links.map((l) => ({ user_id: l.userId, name: l.user.name || (req.auth.agent ? 'Atendente' : l.user.email), ...(req.auth.agent ? {} : { email: l.user.email }), available: isAvailable(l), availability: availabilityLabel(l), online: online.has(l.userId), me: l.userId === req.auth.user?.id })));
});

async function resolveChat(req: Request, raw: unknown): Promise<string> {
  const instanceId = inst(req).id;
  if (req.auth.agent) return assertAssigned(instanceId, req.auth.agent.userId, raw);
  const chat = await prisma.chat.findFirst({ where: { instanceId, OR: [{ chatid: String(raw) }, { chatlid: String(raw) }] }, select: { chatid: true } });
  if (!chat) throw notFound('Conversa não encontrada');
  return chat.chatid;
}

function publishTicket(instanceId: string, chatid: string, attendantId: string, open: boolean, reason: string) {
  eventBus.publish({ instanceId, eventType: 'chats', payload: { event: { type: 'assignment', chatid, lead_assignedAttendant_id: attendantId, lead_isTicketOpen: open, reason } }, meta: { chatid } });
}

agentRouter.post('/ticket/close', async (req, res) => {
  const { chatid: raw } = parse(z.object({ chatid: z.string().min(3).max(120) }), req.body);
  const chatid = await resolveChat(req, raw);
  const instanceId = inst(req).id;
  // Mantém o atendente gravado: se o cliente voltar, cai de novo com ele (se disponível).
  const chat = await prisma.chat.update({ where: { instanceId_chatid: { instanceId, chatid } }, data: { leadIsTicketOpen: false } });
  publishTicket(instanceId, chatid, chat.leadAssignedAttendantId, false, 'finalizado');
  res.json({ success: true });
});

agentRouter.post('/ticket/transfer', async (req, res) => {
  const p = parse(z.object({ chatid: z.string().min(3).max(120), to: z.string().uuid().or(z.literal('')) }), req.body);
  const chatid = await resolveChat(req, p.chatid);
  const instanceId = inst(req).id;
  // Entre atendentes, só quem está atendendo transfere (resolveChat já exige que a conversa
  // seja dele). O dono/admin pode reatribuir como supervisor — ex.: atendente faltou.
  if (p.to) {
    const target = await prisma.instanceAgent.findUnique({ where: { instanceId_userId: { instanceId, userId: p.to } }, include: { user: { select: { isActive: true } } } });
    if (!target?.active || !target.user.isActive) throw badRequest('Atendente de destino não atende este número');
  }
  await prisma.chat.update({ where: { instanceId_chatid: { instanceId, chatid } }, data: { leadIsTicketOpen: true, leadAssignedAttendantId: p.to } });
  if (p.to) await prisma.instanceAgent.update({ where: { instanceId_userId: { instanceId, userId: p.to } }, data: { lastAssignedAt: new Date() } });
  publishTicket(instanceId, chatid, p.to, true, p.to ? 'transferido' : 'fila');
  await audit({ ...actor(req), action: 'ticket.transfer', targetType: 'chat', targetId: chatid, ip: req.ip, requestId: req.id, metadata: { instanceId, to: p.to || 'fila' } });
  if (!p.to) void drainQueue(instanceId).catch(() => undefined);
  res.json({ success: true });
});

// ------------------------------------------------------------------ o próprio atendente
agentRouter.get('/agent/me', requireUser, async (req, res) => {
  if (req.auth.user!.role !== 'agent') throw forbidden('Apenas para atendentes');
  const links = await prisma.instanceAgent.findMany({
    where: { userId: req.auth.user!.id, active: true },
    include: { instance: { select: { id: true, name: true, status: true, connectedPhone: true, profileName: true, profilePicUrl: true, fieldsMap: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const opens = await prisma.chat.groupBy({ by: ['instanceId'], where: { leadAssignedAttendantId: req.auth.user!.id, leadIsTicketOpen: true }, _count: true });
  const byInst = new Map<string, number>(opens.map((o): [string, number] => [o.instanceId, Number(o._count)]));
  res.json({
    instances: links.map((l) => ({
      id: l.instance.id,
      name: l.instance.name,
      status: l.instance.status,
      owner: l.instance.connectedPhone,
      profileName: l.instance.profileName,
      profilePicUrl: l.instance.profilePicUrl,
      fieldsMap: l.instance.fieldsMap ?? {},
      agent_status: l.status,
      pause_reason: l.pauseReason,
      paused_until: l.pausedUntil?.toISOString() ?? null,
      break_start: l.breakStart,
      break_end: l.breakEnd,
      available: isAvailable(l),
      availability: availabilityLabel(l),
      open_chats: byInst.get(l.instanceId) ?? 0,
    })),
  });
});

agentRouter.post('/agent/status', requireUser, async (req, res) => {
  if (req.auth.user!.role !== 'agent') throw forbidden('Apenas para atendentes');
  const p = parse(
    z.object({
      instance_id: z.string().uuid().optional(), // ausente = todos os números do atendente
      status: z.enum(['available', 'paused']),
      pause_reason: z.enum(PAUSE_REASONS).optional(),
      paused_until: z.string().datetime({ offset: true }).nullable().optional(),
    }),
    req.body,
  );
  const where = { userId: req.auth.user!.id, active: true, ...(p.instance_id ? { instanceId: p.instance_id } : {}) };
  const r = await prisma.instanceAgent.updateMany({
    where,
    data: p.status === 'available'
      ? { status: 'available', pauseReason: '', pausedUntil: null }
      : { status: 'paused', pauseReason: p.pause_reason ?? 'outro', pausedUntil: p.paused_until ? new Date(p.paused_until) : null },
  });
  if (!r.count) throw notFound('Número não encontrado');
  if (p.status === 'paused' && p.pause_reason === 'ferias') {
    const links = await prisma.instanceAgent.findMany({ where, select: { instanceId: true } });
    for (const l of links) {
      await requeueAgentChats(l.instanceId, req.auth.user!.id);
      void drainQueue(l.instanceId).catch(() => undefined);
    }
  }
  if (p.status === 'available') {
    const links = await prisma.instanceAgent.findMany({ where, select: { instanceId: true } });
    for (const l of links) void drainQueue(l.instanceId).catch(() => undefined);
  }
  res.json({ success: true, updated: r.count });
});
