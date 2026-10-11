import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { SessionManager } from '../whatsapp/SessionManager.js';

/** Contatos, etiquetas, respostas rápidas e chamadas. */
export const contactRouter = Router();

const scope = z.enum(['address_book', 'outside_address_book', 'all']);
const scopeWhere = (s: z.infer<typeof scope>): Prisma.ContactWhereInput =>
  s === 'address_book' ? { inAddressBook: true } : s === 'outside_address_book' ? { inAddressBook: false } : {};

contactRouter.get('/contacts', async (req, res) => {
  const s = scope.catch('address_book').parse(req.query.contactScope ?? 'address_book');
  const rows = await prisma.contact.findMany({ where: { instanceId: inst(req).id, ...scopeWhere(s) }, orderBy: { fullName: 'asc' }, take: 20_000 });
  res.json(rows.map((c) => ({ jid: c.jid, contact_name: c.fullName || c.pushName, contact_FirstName: c.firstName })));
});

contactRouter.post('/contacts/list', async (req, res) => {
  const p = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100), offset: z.coerce.number().int().min(0).default(0), contactScope: scope.default('address_book') }), req.body);
  const where = { instanceId: inst(req).id, ...scopeWhere(p.contactScope) };
  const [rows, total, device] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: { fullName: 'asc' }, skip: p.offset, take: p.limit }),
    prisma.contact.count({ where }),
    prisma.contact.count({ where: { instanceId: inst(req).id, inAddressBook: true } }),
  ]);
  res.json({
    contacts: rows.map((c) => ({ jid: c.jid, lid: c.lid, contact_name: c.fullName, contact_FirstName: c.firstName, push_name: c.pushName, business_name: c.businessName, in_address_book: c.inAddressBook })),
    totalDeviceContacts: device,
    pagination: { totalRecords: total, limit: p.limit, offset: p.offset },
  });
});

contactRouter.post('/contact/add', async (req, res) => {
  const p = parse(z.object({ number: z.string().min(3).max(120), name: z.string().trim().min(1).max(200) }), req.body);
  const i = inst(req);
  const jid = toJid(p.number);
  const s = SessionManager.get(i.id);
  if (s?.isConnected) await s.call('addOrEditContact', jid, { fullName: p.name, firstName: p.name.split(' ')[0], saveOnPrimaryAddressbook: true }).catch(() => undefined);
  const contact = await prisma.contact.upsert({
    where: { instanceId_jid: { instanceId: i.id, jid } },
    create: { instanceId: i.id, jid, fullName: p.name, firstName: p.name.split(' ')[0] ?? '', inAddressBook: true },
    update: { fullName: p.name, firstName: p.name.split(' ')[0] ?? '', inAddressBook: true },
  });
  res.json({ success: true, message: 'Contato salvo', contact: { jid: contact.jid, name: contact.fullName } });
});

contactRouter.post('/contact/remove', async (req, res) => {
  const { number } = parse(z.object({ number: z.string().min(3).max(120) }), req.body);
  const i = inst(req);
  const jid = toJid(number);
  const s = SessionManager.get(i.id);
  if (s?.isConnected) await s.call('removeContact', jid).catch(() => undefined);
  await prisma.contact.updateMany({ where: { instanceId: i.id, jid }, data: { inAddressBook: false, fullName: '', firstName: '' } });
  res.json({ success: true, message: 'Contato removido', removed_contact: jid });
});

// ---------- Etiquetas (WhatsApp Business) ----------
contactRouter.post('/label/edit', async (req, res) => {
  const p = parse(z.object({ labelid: z.string().min(1).max(40), name: z.string().max(100).optional(), color: z.coerce.number().int().min(0).max(19).optional(), delete: z.boolean().optional() }), req.body);
  const i = inst(req);
  const s = await SessionManager.requireConnected(i);
  await s.call('addLabel', '', { id: p.labelid, name: p.name, color: p.color, deleted: Boolean(p.delete) });
  if (p.delete) await prisma.label.deleteMany({ where: { instanceId: i.id, labelid: p.labelid } });
  else
    await prisma.label.upsert({
      where: { instanceId_labelid: { instanceId: i.id, labelid: p.labelid } },
      create: { instanceId: i.id, labelid: p.labelid, name: p.name ?? '', color: p.color ?? 0 },
      update: { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.color !== undefined ? { color: p.color } : {}) },
    });
  res.json({ response: p.delete ? 'Label deleted' : 'Label saved' });
});

const LABEL_HEX = ['#ff9485', '#64c4ff', '#ffd429', '#dfaef0', '#99b6c1', '#55ccb3', '#ff9dff', '#d3a91d', '#6d7cce', '#d7e752', '#00d0e2', '#ffc5c7', '#93ceac', '#f74848', '#00a0f2', '#83e422', '#ffaf04', '#b5ebff', '#9ba6ff', '#9368cf'];
contactRouter.get('/labels', async (req, res) => {
  const rows = await prisma.label.findMany({ where: { instanceId: inst(req).id }, orderBy: { labelid: 'asc' } });
  res.json(rows.map((l) => ({ id: l.id, labelid: l.labelid, name: l.name, color: l.color, colorHex: LABEL_HEX[l.color] ?? '#999999', owner: inst(req).connectedPhone, created: l.createdAt, updated: l.updatedAt })));
});

contactRouter.post('/labels/refresh', async (req, res) => {
  const { force } = parse(z.object({ force: z.boolean().default(false) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  await s.call('resyncAppState', ['regular', 'regular_high', 'regular_low', 'critical_block', 'critical_unblock_low'], force).catch(() => undefined);
  res.json({ success: true, status: 'started', message: 'Ressincronização solicitada; alterações chegam pelo evento labels', force, fullSync: force });
});

// ---------- Respostas rápidas ----------
contactRouter.post('/quickreply/edit', async (req, res) => {
  const p = parse(
    z.object({
      id: z.string().uuid().optional(),
      delete: z.boolean().default(false),
      onWhatsApp: z.boolean().default(false),
      shortCut: z.string().trim().min(1).max(60),
      type: z.enum(['text', 'audio', 'myaudio', 'ptt', 'document', 'video', 'image']),
      text: z.string().max(65_000).optional(),
      file: z.string().max(2000).optional(),
      docName: z.string().max(255).optional(),
    }),
    req.body,
  );
  const instanceId = inst(req).id;
  if (p.delete) {
    if (!p.id) throw badRequest('id obrigatório para excluir');
    await prisma.quickReply.deleteMany({ where: { id: p.id, instanceId } });
  } else if (p.id) {
    const found = await prisma.quickReply.findFirst({ where: { id: p.id, instanceId } });
    if (!found) throw notFound('Resposta rápida não encontrada');
    await prisma.quickReply.update({ where: { id: p.id }, data: { shortCut: p.shortCut, type: p.type, text: p.text ?? '', file: p.file ?? '', docName: p.docName ?? '', onWhatsApp: p.onWhatsApp } });
  } else {
    await prisma.quickReply.create({ data: { instanceId, shortCut: p.shortCut, type: p.type, text: p.text ?? '', file: p.file ?? '', docName: p.docName ?? '', onWhatsApp: p.onWhatsApp } });
  }
  const all = await prisma.quickReply.findMany({ where: { instanceId }, orderBy: { shortCut: 'asc' } });
  res.json({ message: 'ok', quickReplies: all });
});

contactRouter.get('/quickreply/showall', async (req, res) => {
  const all = await prisma.quickReply.findMany({ where: { instanceId: inst(req).id }, orderBy: { shortCut: 'asc' } });
  res.json(all.map((q) => ({ ...q, owner: inst(req).connectedPhone, created: q.createdAt, updated: q.updatedAt })));
});

// ---------- Chamadas ----------
contactRouter.post('/call/reject', async (req, res) => {
  const p = parse(z.object({ number: z.string().max(120).optional(), id: z.string().max(200).optional() }), req.body);
  if (!p.id || !p.number) throw badRequest('Informe number e id da chamada (recebidos no evento call)');
  const s = await SessionManager.requireConnected(inst(req));
  await s.sock!.rejectCall(p.id, toJid(p.number));
  res.json({ response: 'Call rejected' });
});

contactRouter.post('/call/make', () => {
  throw badRequest('Iniciar chamadas não é suportado pelo Baileys');
});
