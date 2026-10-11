import type { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { buildChatWhere, buildSort } from '../lib/chatFilter.js';
import { ACCENTS_FROM, ACCENTS_TO, chatSearchPatterns } from '../lib/chatSearch.js';
import { canSeeLocked } from '../lib/lockedChats.js';
import { forbidden } from '../lib/errors.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { presentChat } from '../whatsapp/presenters.js';

export const chatRouter = Router();

const numberSchema = z.object({ number: z.string().min(3).max(120) });

async function lastMessageKeys(instanceId: string, chatid: string) {
  const last = await prisma.message.findFirst({ where: { instanceId, chatid }, orderBy: { messageTimestamp: 'desc' } });
  return last
    ? [{ key: { remoteJid: chatid, id: last.messageid, fromMe: last.fromMe, ...(last.isGroup && last.sender ? { participant: last.sender } : {}) }, messageTimestamp: Math.floor(Number(last.messageTimestamp) / 1000) }]
    : [];
}

async function chatOr404(req: Request, chatid: string) {
  const c = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: inst(req).id, chatid } } });
  if (!c) throw notFound('Chat não encontrado');
  return c;
}

// ---------- Ações no WhatsApp ----------

chatRouter.post('/chat/block', async (req, res) => {
  const p = parse(numberSchema.extend({ block: z.boolean() }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  const jid = toJid(p.number);
  await s.sock!.updateBlockStatus(jid, p.block ? 'block' : 'unblock');
  await prisma.chat.updateMany({ where: { instanceId: inst(req).id, chatid: jid }, data: { blocked: p.block } });
  res.json({ response: p.block ? 'Blocked' : 'Unblocked', blockList: await s.sock!.fetchBlocklist() });
});

chatRouter.get('/chat/blocklist', async (req, res) => {
  const s = await SessionManager.requireConnected(inst(req));
  res.json({ blockList: await s.sock!.fetchBlocklist() });
});

chatRouter.post('/chat/labels', async (req, res) => {
  const p = parse(
    numberSchema.extend({ labelids: z.array(z.string().max(40)).max(20).optional(), add_labelid: z.string().max(40).optional(), remove_labelid: z.string().max(40).optional() }),
    req.body,
  );
  const i = inst(req);
  const s = await SessionManager.requireConnected(i);
  const jid = toJid(p.number);
  const chat = await chatOr404(req, jid);
  const current = new Set(chat.labels);
  const target = new Set(p.labelids ?? current);
  if (p.add_labelid) target.add(p.add_labelid);
  if (p.remove_labelid) target.delete(p.remove_labelid);
  const editions: string[] = [];
  for (const id of target) if (!current.has(id)) { await s.call('addChatLabel', jid, id); editions.push(`+${id}`); }
  for (const id of current) if (!target.has(id)) { await s.call('removeChatLabel', jid, id); editions.push(`-${id}`); }
  await prisma.chat.update({ where: { id: chat.id }, data: { labels: [...target] } });
  res.json({ response: 'Labels updated', editions });
});

chatRouter.post('/chat/delete', async (req, res) => {
  const p = parse(numberSchema.extend({ deleteChatDB: z.boolean().default(false), deleteMessagesDB: z.boolean().default(false), deleteChatWhatsApp: z.boolean().default(false), clearChatWhatsApp: z.boolean().default(false) }), req.body);
  const i = inst(req);
  const jid = toJid(p.number);
  const actions: string[] = [];
  const errors: string[] = [];
  if (p.deleteChatWhatsApp || p.clearChatWhatsApp) {
    const s = await SessionManager.requireConnected(i);
    const lastMessages = await lastMessageKeys(i.id, jid);
    try {
      if (p.deleteChatWhatsApp) await s.sock!.chatModify({ delete: true, lastMessages } as never, jid);
      else await s.sock!.chatModify({ clear: true, lastMessages } as never, jid);
      actions.push(p.deleteChatWhatsApp ? 'deleteChatWhatsApp' : 'clearChatWhatsApp');
    } catch (err) {
      errors.push((err as Error).message.slice(0, 200));
    }
  }
  if (p.deleteMessagesDB) {
    await prisma.message.deleteMany({ where: { instanceId: i.id, chatid: jid } });
    actions.push('deleteMessagesDB');
  }
  if (p.deleteChatDB) {
    await prisma.chat.deleteMany({ where: { instanceId: i.id, chatid: jid } });
    actions.push('deleteChatDB');
  }
  res.json({ response: 'ok', actions, errors });
});

async function modify(req: Request, build: (lastMessages: unknown[]) => Record<string, unknown>, dbPatch: Prisma.ChatUpdateManyMutationInput) {
  const p = parse(numberSchema.passthrough(), req.body);
  const i = inst(req);
  const s = await SessionManager.requireConnected(i);
  const jid = toJid(p.number);
  await s.sock!.chatModify(build(await lastMessageKeys(i.id, jid)) as never, jid);
  await prisma.chat.updateMany({ where: { instanceId: i.id, chatid: jid }, data: dbPatch });
}

chatRouter.post('/chat/archive', async (req, res) => {
  const { archive } = parse(z.object({ archive: z.boolean() }).passthrough(), req.body);
  await modify(req, (lastMessages) => ({ archive, lastMessages }), { archived: archive });
  res.json({ response: archive ? 'Archived' : 'Unarchived' });
});

chatRouter.post('/chat/read', async (req, res) => {
  const { read } = parse(z.object({ read: z.boolean() }).passthrough(), req.body);
  await modify(req, (lastMessages) => ({ markRead: read, lastMessages }), read ? { unreadCount: 0 } : {});
  res.json({ response: read ? 'Marked as read' : 'Marked as unread' });
});

chatRouter.post('/chat/mute', async (req, res) => {
  // 0 = desmutar, 8 = 8h, 168 = 1 semana, -1 = sempre
  const { muteEndTime } = parse(z.object({ muteEndTime: z.coerce.number().int().refine((v) => [0, 8, 168, -1].includes(v), 'use 0, 8, 168 ou -1') }).passthrough(), req.body);
  const ms = muteEndTime === 0 ? null : muteEndTime === -1 ? -1 : muteEndTime * 3600_000;
  const until = ms === null ? 0 : ms === -1 ? -1 : Date.now() + ms;
  await modify(req, () => ({ mute: ms === -1 ? 8 * 365 * 24 * 3600_000 : ms }), { muteEndTime: BigInt(until) });
  res.json({ response: muteEndTime === 0 ? 'Unmuted' : 'Muted' });
});

chatRouter.post('/chat/pin', async (req, res) => {
  const { pin } = parse(z.object({ pin: z.boolean() }).passthrough(), req.body);
  await modify(req, () => ({ pin }), { pinned: pin });
  res.json({ response: pin ? 'Pinned' : 'Unpinned' });
});

chatRouter.post('/chat/ephemeral', async (req, res) => {
  const p = parse(numberSchema.extend({ duration: z.coerce.number().int().refine((v) => [0, 86400, 604800, 7776000].includes(v), 'use 0, 86400, 604800 ou 7776000 (segundos)') }), req.body);
  const i = inst(req);
  const s = await SessionManager.requireConnected(i);
  const jid = toJid(p.number);
  await s.sock!.sendMessage(jid, { disappearingMessagesInChat: p.duration || false } as never);
  await prisma.chat.updateMany({ where: { instanceId: i.id, chatid: jid }, data: { ephemeralExpiration: p.duration } });
  res.json({ response: 'ok', chat: jid, ephemeral: p.duration });
});

// ---------- Consulta / CRM ----------

chatRouter.post('/chat/find', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const compact = body.compact === true;
  const limitDefault = compact ? 100 : 2000;
  const rawLimit = Number(body.limit);
  const limit = Math.min(rawLimit > 0 ? rawLimit : limitDefault, compact ? 200 : 5000);
  const offset = Math.max(0, Number(body.offset) || 0);
  const i = inst(req);
  const { conditions, operator } = buildChatWhere(body);
  const scope: Prisma.ChatWhereInput[] = [];
  // Busca livre (painel): acentos e formato do número não importam.
  const pat = typeof body.q === 'string' ? chatSearchPatterns(body.q) : null;
  if (pat) {
    const digits = pat.digits.length ? pat.digits : ['x']; // 'x' nunca casa com um número só de dígitos
    // Atendente: o filtro dele entra no SQL, senão o LIMIT cortaria as conversas dele.
    const onlyAttendant = req.auth.agent?.userId ?? null;
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM chats
      WHERE "instanceId" = ${i.id}
        AND (${onlyAttendant}::text IS NULL OR "leadAssignedAttendantId" = ${onlyAttendant})
        AND (
          translate(lower(coalesce(name, '') || ' ' || coalesce("contactName", '') || ' ' || coalesce("pushName", '') || ' ' || coalesce("leadName", '') || ' ' || coalesce("leadFullName", '')), ${ACCENTS_FROM}, ${ACCENTS_TO}) LIKE ${pat.text}
          OR regexp_replace(split_part(chatid, '@', 1), '[^0-9]', '', 'g') LIKE ANY (${digits})
          OR chatid ILIKE ${pat.text}
        )
      LIMIT 500`;
    scope.push({ id: { in: rows.map((r) => r.id) } });
  }
  // Atendente só enxerga as conversas atribuídas a ele (ver requireInstance/agentScope).
  if (req.auth.agent) scope.push({ leadAssignedAttendantId: req.auth.agent.userId });
  if (body.queue === true) scope.push({ leadIsTicketOpen: true, leadAssignedAttendantId: '' });
  // Status do WhatsApp não é conversa (aparece em "Atualizações").
  scope.push({ NOT: { chatid: 'status@broadcast' } });
  // Filtros do painel no estilo WhatsApp.
  if (body.unread === true) scope.push({ unreadCount: { gt: 0 } });
  if (typeof body.list === 'string' && body.list) scope.push({ lists: { has: String(body.list).slice(0, 40) } });
  if (typeof body.attendant === 'string' && !req.auth.agent) {
    // Dono filtra por atendente: id do atendente, ou "queue" (na fila sem atendente).
    if (body.attendant === 'queue') scope.push({ leadIsTicketOpen: true, leadAssignedAttendantId: '' });
    else if (/^[0-9a-f-]{36}$/i.test(body.attendant)) scope.push({ leadAssignedAttendantId: body.attendant });
  }
  // Trancadas: só aparecem pedindo explicitamente e com a senha confirmada.
  if (body.locked === true) {
    if (!canSeeLocked(req, i.id)) throw forbidden('Confirme sua senha para ver as conversas trancadas');
    scope.push({ locked: true });
  } else if (req.auth.user) {
    scope.push({ locked: false });
  }
  // Filtros do usuário e escopo (busca/atendente/fila) SEMPRE combinados com AND —
  // nenhum pode sobrescrever o outro.
  const userFilter: Prisma.ChatWhereInput[] = conditions.length ? (operator === 'OR' ? [{ OR: conditions as Prisma.ChatWhereInput[] }] : (conditions as Prisma.ChatWhereInput[])) : [];
  const all = [...userFilter, ...scope];
  const where: Prisma.ChatWhereInput = { instanceId: i.id, ...(all.length ? { AND: all } : {}) };
  const [chats, total, groups, archived, unread] = await Promise.all([
    prisma.chat.findMany({ where, orderBy: buildSort(body.sort) as Prisma.ChatOrderByWithRelationInput, skip: offset, take: limit }),
    prisma.chat.count({ where }),
    prisma.chat.count({ where: { instanceId: i.id, isGroup: true } }),
    prisma.chat.count({ where: { instanceId: i.id, archived: true } }),
    prisma.chat.count({ where: { instanceId: i.id, unreadCount: { gt: 0 } } }),
  ]);
  // Atendente não recebe números da instância inteira (grupos/arquivadas/não lidas de todos).
  const stats = req.auth.agent ? { total } : { total, groups, archived, unread };
  res.json({ chats: chats.map((c) => presentChat(c, i.connectedPhone, compact)), totalChatsStats: stats, pagination: { totalRecords: total, limit, offset } });
});

chatRouter.get('/chat/totalcount', async (req, res) => {
  const id = inst(req).id;
  const [total, open, archived, groups, blocked, labels, attendants] = await Promise.all([
    prisma.chat.count({ where: { instanceId: id } }),
    prisma.chat.count({ where: { instanceId: id, leadIsTicketOpen: true } }),
    prisma.chat.count({ where: { instanceId: id, archived: true } }),
    prisma.chat.count({ where: { instanceId: id, isGroup: true } }),
    prisma.chat.count({ where: { instanceId: id, blocked: true } }),
    prisma.label.findMany({ where: { instanceId: id } }),
    prisma.chat.groupBy({ by: ['leadAssignedAttendantId'], where: { instanceId: id, leadAssignedAttendantId: { not: '' } }, _count: true }),
  ]);
  const label_counts: Record<string, number> = {};
  for (const l of labels) label_counts[l.labelid] = await prisma.chat.count({ where: { instanceId: id, labels: { has: l.labelid } } });
  res.json({
    total_chats: total,
    open_chats: open,
    archived_chats: archived,
    group_chats: groups,
    blocked_chats: blocked,
    label_counts,
    attendant_counts: Object.fromEntries(attendants.map((a) => [a.leadAssignedAttendantId, a._count])),
  });
});

const leadFieldsShape: Record<string, z.ZodOptional<z.ZodString>> = {};
for (let n = 1; n <= 20; n++) leadFieldsShape[`lead_field${String(n).padStart(2, '0')}`] = z.string().max(1000).optional();

chatRouter.post('/chat/editLead', async (req, res) => {
  const p = parse(
    z.object({
      id: z.string().min(1).max(120),
      chatbot_disableUntil: z.coerce.number().int().optional(),
      lead_isTicketOpen: z.boolean().optional(),
      lead_assignedAttendant_id: z.string().max(100).optional(),
      lead_kanbanOrder: z.coerce.number().int().optional(),
      lead_tags: z.array(z.string().max(60)).max(50).optional(),
      lead_name: z.string().max(200).optional(),
      lead_fullName: z.string().max(300).optional(),
      lead_email: z.string().email().max(200).optional().or(z.literal('')),
      lead_personalid: z.string().max(50).optional(),
      lead_status: z.string().max(60).optional(),
      lead_notes: z.string().max(5000).optional(),
      ...leadFieldsShape,
    }),
    req.body,
  );
  const i = inst(req);
  // `id` pode ser o id interno do chat ou o JID/número.
  let chat = await prisma.chat.findFirst({ where: { instanceId: i.id, id: p.id } });
  if (!chat) {
    const jid = toJid(p.id);
    chat = await prisma.chat.upsert({ where: { instanceId_chatid: { instanceId: i.id, chatid: jid } }, create: { instanceId: i.id, chatid: jid, isGroup: jid.endsWith('@g.us') }, update: {} });
  }
  const fields = { ...((chat.leadFields ?? {}) as Record<string, string>) };
  for (const k of Object.keys(leadFieldsShape)) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v === 'string') fields[k] = v;
  }
  const updated = await prisma.chat.update({
    where: { id: chat.id },
    data: {
      ...(p.chatbot_disableUntil !== undefined ? { chatbotDisableUntil: BigInt(p.chatbot_disableUntil) } : {}),
      ...(p.lead_isTicketOpen !== undefined ? { leadIsTicketOpen: p.lead_isTicketOpen } : {}),
      ...(p.lead_assignedAttendant_id !== undefined ? { leadAssignedAttendantId: p.lead_assignedAttendant_id } : {}),
      ...(p.lead_kanbanOrder !== undefined ? { leadKanbanOrder: BigInt(p.lead_kanbanOrder) } : {}),
      ...(p.lead_tags !== undefined ? { leadTags: p.lead_tags } : {}),
      ...(p.lead_name !== undefined ? { leadName: p.lead_name } : {}),
      ...(p.lead_fullName !== undefined ? { leadFullName: p.lead_fullName } : {}),
      ...(p.lead_email !== undefined ? { leadEmail: p.lead_email } : {}),
      ...(p.lead_personalid !== undefined ? { leadPersonalId: p.lead_personalid } : {}),
      ...(p.lead_status !== undefined ? { leadStatus: p.lead_status } : {}),
      ...(p.lead_notes !== undefined ? { leadNotes: p.lead_notes } : {}),
      leadFields: fields,
    },
  });
  res.json(presentChat(updated, i.connectedPhone));
});

chatRouter.post('/chat/details', async (req, res) => {
  const p = parse(numberSchema.extend({ preview: z.boolean().default(false) }), req.body);
  const i = inst(req);
  const jid = toJid(p.number);
  const chat = await prisma.chat.upsert({ where: { instanceId_chatid: { instanceId: i.id, chatid: jid } }, create: { instanceId: i.id, chatid: jid, isGroup: jid.endsWith('@g.us') }, update: {} });
  let is_business = false;
  let business_name = '';
  const s = SessionManager.get(i.id);
  if (s?.isConnected && !chat.isGroup) {
    const biz = await s.sock!.getBusinessProfile(jid).catch(() => undefined);
    is_business = Boolean(biz);
    const contact = await prisma.contact.findUnique({ where: { instanceId_jid: { instanceId: i.id, jid } } });
    business_name = contact?.businessName ?? '';
    if (!chat.image) {
      const url = await s.sock!.profilePictureUrl(jid, p.preview ? 'preview' : 'image').catch(() => undefined);
      if (url) await prisma.chat.update({ where: { id: chat.id }, data: { image: url } });
    }
  }
  const fresh = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
  res.json({ ...presentChat(fresh, i.connectedPhone), is_business, business_name });
});

chatRouter.post('/chat/avatar', async (req, res) => {
  const p = parse(numberSchema.extend({ preview: z.boolean().default(false), force: z.boolean().default(false) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  const url = await s.sock!.profilePictureUrl(toJid(p.number), p.preview ? 'preview' : 'image').catch(() => null);
  res.json({ url: url ?? '' });
});

chatRouter.post('/chat/check', async (req, res) => {
  const { numbers } = parse(z.object({ numbers: z.array(z.string().max(120)).min(1).max(500) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  const out: Array<Record<string, unknown>> = [];
  for (const q of numbers) {
    try {
      const jid = toJid(q);
      if (jid.endsWith('@g.us')) {
        const meta = await s.sock!.groupMetadata(jid).catch(() => undefined);
        out.push({ query: q, jid, lid: '', isInWhatsapp: Boolean(meta), verifiedName: '', groupName: meta?.subject ?? '', error: '' });
        continue;
      }
      const [r] = (await s.sock!.onWhatsApp(jid)) ?? [];
      out.push({ query: q, jid: r?.jid ?? jid, lid: (r as { lid?: string } | undefined)?.lid ?? '', isInWhatsapp: Boolean(r?.exists), verifiedName: '', groupName: '', error: '' });
    } catch (err) {
      out.push({ query: q, jid: '', lid: '', isInWhatsapp: false, verifiedName: '', groupName: '', error: (err as Error).message.slice(0, 100) });
    }
  }
  res.json(out);
});

// Notas internas do chat (armazenadas localmente).
chatRouter.post('/chat/notes', async (req, res) => {
  const { number } = parse(numberSchema, req.body);
  const chat = await chatOr404(req, toJid(number));
  res.json({ chat: chat.chatid, wa_notes: chat.notes, source: 'local' });
});
chatRouter.post('/chat/notes/refresh', async (req, res) => {
  const { number } = parse(numberSchema.extend({ force: z.boolean().optional() }), req.body);
  const chat = await chatOr404(req, toJid(number));
  res.json({ chat: chat.chatid, wa_notes: chat.notes, source: 'local' });
});
chatRouter.post('/chat/notes/edit', async (req, res) => {
  const p = parse(numberSchema.extend({ notes: z.string().max(10_000) }), req.body);
  const chat = await chatOr404(req, toJid(p.number));
  await prisma.chat.update({ where: { id: chat.id }, data: { notes: p.notes } });
  res.json({ response: 'ok', chat: chat.chatid, wa_notes: p.notes, source: 'local' });
});

// ---------- Tags de lead ----------
chatRouter.get('/lead/tags', async (req, res) => {
  const tags = await prisma.leadTag.findMany({ where: { instanceId: inst(req).id }, orderBy: { kanbanOrder: 'asc' } });
  res.json(tags.map((t) => ({ id: t.id, name: t.name, kanban: t.kanban, kanbanOrder: Number(t.kanbanOrder), owner: inst(req).connectedPhone, created: t.createdAt, updated: t.updatedAt })));
});

chatRouter.post('/lead/tags/edit', async (req, res) => {
  const p = parse(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60).optional(), kanban: z.boolean().optional(), kanbanOrder: z.coerce.number().int().optional(), delete: z.boolean().optional() }), req.body);
  const instanceId = inst(req).id;
  if (p.delete) {
    if (!p.id) throw badRequest('id obrigatório para excluir');
    await prisma.leadTag.deleteMany({ where: { id: p.id, instanceId } });
    res.json({ id: p.id, deleted: true });
    return;
  }
  const data = { ...(p.name ? { name: p.name } : {}), ...(p.kanban !== undefined ? { kanban: p.kanban } : {}), ...(p.kanbanOrder !== undefined ? { kanbanOrder: BigInt(p.kanbanOrder) } : {}) };
  let tag;
  if (p.id) {
    const found = await prisma.leadTag.findFirst({ where: { id: p.id, instanceId } });
    if (!found) throw notFound('Tag não encontrada');
    tag = await prisma.leadTag.update({ where: { id: p.id }, data });
  } else {
    if (!p.name) throw badRequest('name obrigatório');
    tag = await prisma.leadTag.create({ data: { instanceId, name: p.name, kanban: p.kanban ?? false, kanbanOrder: BigInt(p.kanbanOrder ?? 0) } });
  }
  res.json({ id: tag.id, name: tag.name, kanban: tag.kanban, kanbanOrder: Number(tag.kanbanOrder), created: tag.createdAt, updated: tag.updatedAt });
});
