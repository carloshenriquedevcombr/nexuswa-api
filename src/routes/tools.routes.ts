import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { burnPasswordCheck, verifyPassword } from '../auth/password.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { canSeeLocked, UNLOCK_SECRET } from '../lib/lockedChats.js';
import { signUnlock } from '../lib/unlockToken.js';
import { parse } from '../lib/validate.js';
import { inst, requireInstance } from '../middlewares/auth.js';
import { sensitiveLimiter } from '../middlewares/rateLimit.js';
import { audit } from '../services/audit.js';
import { SessionManager } from '../whatsapp/SessionManager.js';

/**
 * Ferramentas do painel no estilo WhatsApp: listas/favoritas, conversa trancada e
 * perfil (recado). Listas e trava são do PAINEL (guardadas aqui): o WhatsApp não expõe
 * essas funções para aparelhos conectados, então não aparecem no celular.
 */
export const toolsRouter = Router();

export const FAVORITES = 'favoritas';

function assertNotAgent(req: Request): void {
  if (req.auth.agent) throw forbidden('Atendentes não alteram esta configuração');
}

// ------------------------------------------------------------------ listas
toolsRouter.get('/lists', async (req, res) => {
  const instanceId = inst(req).id;
  const lists = await prisma.chatList.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  res.json([{ id: FAVORITES, name: 'Favoritas', builtin: true }, ...lists.map((l) => ({ id: l.id, name: l.name, builtin: false }))]);
});

toolsRouter.post('/lists', async (req, res) => {
  assertNotAgent(req);
  const p = parse(z.object({ action: z.enum(['create', 'rename', 'delete']), id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40).optional() }), req.body);
  const instanceId = inst(req).id;
  if (p.action === 'create') {
    if (!p.name) throw badRequest('Informe o nome da lista');
    if ((await prisma.chatList.count({ where: { instanceId } })) >= 30) throw badRequest('Máximo de 30 listas');
    await prisma.chatList.create({ data: { instanceId, name: p.name } });
  } else {
    if (!p.id) throw badRequest('id obrigatório');
    const found = await prisma.chatList.findFirst({ where: { id: p.id, instanceId } });
    if (!found) throw notFound('Lista não encontrada');
    if (p.action === 'rename') {
      if (!p.name) throw badRequest('Informe o novo nome');
      await prisma.chatList.update({ where: { id: p.id }, data: { name: p.name } });
    } else {
      await prisma.chatList.delete({ where: { id: p.id } });
      // Tira a lista das conversas (array_remove), sem carregar todas na memória.
      await prisma.$executeRaw`UPDATE chats SET lists = array_remove(lists, ${p.id}) WHERE "instanceId" = ${instanceId} AND ${p.id} = ANY(lists)`;
    }
  }
  const lists = await prisma.chatList.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  res.json([{ id: FAVORITES, name: 'Favoritas', builtin: true }, ...lists.map((l) => ({ id: l.id, name: l.name, builtin: false }))]);
});

toolsRouter.post('/chat/lists', async (req, res) => {
  // Atendente: liberado só para "favoritas" nas conversas dele (checado em agentScope).
  const p = parse(z.object({ number: z.string().min(3).max(120), add: z.array(z.string().max(40)).max(30).default([]), remove: z.array(z.string().max(40)).max(30).default([]) }), req.body);
  const instanceId = inst(req).id;
  const jid = toJid(p.number);
  const valid = new Set([FAVORITES, ...(await prisma.chatList.findMany({ where: { instanceId }, select: { id: true } })).map((l) => l.id)]);
  const chat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId, chatid: jid } } });
  if (!chat) throw notFound('Conversa não encontrada');
  const next = new Set((chat.lists ?? []).filter((l) => valid.has(l)));
  for (const a of p.add) if (valid.has(a)) next.add(a);
  for (const r of p.remove) next.delete(r);
  await prisma.chat.update({ where: { id: chat.id }, data: { lists: [...next] } });
  res.json({ lists: [...next] });
});

// ------------------------------------------------------------------ trancar
toolsRouter.post('/chat/lock', async (req, res) => {
  assertNotAgent(req);
  const p = parse(z.object({ number: z.string().min(3).max(120), locked: z.boolean() }), req.body);
  const instanceId = inst(req).id;
  // Destrancar exige a senha confirmada (senão bastaria uma sessão aberta esquecida).
  if (!p.locked && !canSeeLocked(req, instanceId)) throw forbidden('Confirme sua senha para destrancar');
  const r = await prisma.chat.updateMany({ where: { instanceId, chatid: toJid(p.number) }, data: { locked: p.locked } });
  if (!r.count) throw notFound('Conversa não encontrada');
  await audit({ actorType: req.auth.user ? 'user' : 'instance', actorId: req.auth.user?.id ?? instanceId, action: p.locked ? 'chat.lock' : 'chat.unlock', targetType: 'chat', targetId: toJid(p.number), ip: req.ip, requestId: req.id, metadata: { instanceId } });
  res.json({ locked: p.locked });
});

/** Confirma a senha e devolve o comprovante para ver as conversas trancadas (15 min). */
toolsRouter.post('/chat/unlock', sensitiveLimiter, async (req, res) => {
  assertNotAgent(req);
  const u = req.auth.user;
  if (!u) throw unauthorized('Login necessário');
  const { password } = parse(z.object({ password: z.string().min(1).max(256) }), req.body);
  const user = await prisma.user.findUnique({ where: { id: u.id } });
  if (!user) {
    await burnPasswordCheck(password);
    throw unauthorized('Senha incorreta');
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit({ actorType: 'user', actorId: u.id, action: 'chat.unlock.fail', ip: req.ip, requestId: req.id });
    throw unauthorized('Senha incorreta');
  }
  res.json({ unlock_token: signUnlock(UNLOCK_SECRET, u.id, inst(req).id), expires_in: 900 });
});

// ------------------------------------------------------------------ perfil
toolsRouter.get('/profile/info', requireInstance, async (req, res) => {
  assertNotAgent(req);
  const i = inst(req);
  const s = await SessionManager.requireConnected(i);
  const me = s.sock!.user!.id.replace(/:\d+@/, '@');
  const [picture, about, business] = await Promise.all([
    s.sock!.profilePictureUrl(me, 'image').catch(() => ''),
    s.sock!.fetchStatus(me).then((r: unknown) => {
      const first = Array.isArray(r) ? (r[0] as { status?: { status?: string } })?.status : (r as { status?: string } | undefined);
      return (first as { status?: string } | undefined)?.status ?? '';
    }).catch(() => ''),
    i.isBusiness ? s.sock!.getBusinessProfile(me).catch(() => null) : Promise.resolve(null),
  ]);
  res.json({ name: i.profileName, phone: i.connectedPhone, picture, about, isBusiness: i.isBusiness, business });
});

toolsRouter.post('/profile/status', requireInstance, async (req, res) => {
  assertNotAgent(req);
  const { about } = parse(z.object({ about: z.string().max(139) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  await s.sock!.updateProfileStatus(about);
  res.json({ success: true, about });
});
