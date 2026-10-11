import { downloadMediaMessage, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import type { Message, Prisma } from '@prisma/client';
import { Router } from 'express';
import { pino } from 'pino';
import { z } from 'zod';
import { env } from '../config/env.js';
import { badRequest, conflict, forbidden, notImplemented } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { decField } from '../lib/security.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { asyncStatus, clearAsync } from '../services/asyncQueue.js';
import { storeFile, toMp3 } from '../services/media.js';
import { transcribe } from '../services/transcription.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { contentType, mediaDownloadHost, unwrap } from '../whatsapp/normalizer.js';
import { presentMessage } from '../whatsapp/presenters.js';
import { loadWaMessage } from '../whatsapp/store.js';
import { canSeeLocked } from '../lib/lockedChats.js';

export const messageRouter = Router();
const silent = pino({ level: 'silent' });
const TEXT_TYPES = new Set(['conversation', 'extendedTextMessage']);

const keyOf = (row: Message): WAMessageKey => ({
  remoteJid: row.chatid,
  id: row.messageid,
  fromMe: row.fromMe,
  ...(row.isGroup && row.sender ? { participant: row.sender } : {}),
});

messageRouter.get('/message/async', async (req, res) => {
  res.json(await asyncStatus(inst(req)));
});
messageRouter.delete('/message/async', async (req, res) => {
  res.json(await clearAsync(inst(req)));
});

messageRouter.post('/message/find', async (req, res) => {
  const p = parse(
    z.object({
      id: z.string().max(200).optional(),
      chatid: z.string().max(120).optional(),
      messageType: z.string().max(60).optional(),
      track_source: z.string().max(100).optional(),
      track_id: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.body,
  );
  const i = inst(req);
  // Conversa trancada: pessoa só lê com a senha confirmada (X-Unlock-Token).
  let hideChats: string[] = [];
  if (!canSeeLocked(req, i.id)) {
    if (p.chatid) {
      const c = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: i.id, chatid: p.chatid } }, select: { locked: true } });
      if (c?.locked) throw forbidden('Conversa trancada: confirme sua senha para abrir');
    } else {
      hideChats = (await prisma.chat.findMany({ where: { instanceId: i.id, locked: true }, select: { chatid: true } })).map((c) => c.chatid);
    }
  }
  const where: Prisma.MessageWhereInput = {
    instanceId: i.id,
    ...(hideChats.length ? { NOT: { chatid: { in: hideChats } } } : {}),
    ...(p.id ? { OR: [{ id: p.id }, { messageid: p.id }] } : {}),
    ...(p.chatid ? { chatid: p.chatid } : {}),
    ...(p.messageType ? { messageType: p.messageType } : {}),
    ...(p.track_source ? { trackSource: p.track_source } : {}),
    ...(p.track_id ? { trackId: p.track_id } : {}),
  };
  // O WhatsApp só dá o horário em segundos: no mesmo segundo, desempata pela ordem de chegada.
  const rows = await prisma.message.findMany({ where, orderBy: [{ messageTimestamp: 'desc' }, { createdAt: 'desc' }], skip: p.offset, take: p.limit + 1 });
  const hasMore = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  res.json({ returnedMessages: page.length, messages: page.map((m) => {
    const out = presentMessage(m, i.connectedPhone) as Record<string, unknown>;
    if (req.auth.agent) delete out.original_text; // histórico de edição é só do dono/admin
    return out;
  }), limit: p.limit, offset: p.offset, nextOffset: hasMore ? p.offset + p.limit : null, hasMore });
});

messageRouter.post('/message/download', async (req, res) => {
  const p = parse(
    z.object({
      id: z.string().min(1).max(200),
      return_base64: z.boolean().default(false),
      generate_mp3: z.boolean().default(true),
      return_link: z.boolean().default(true),
      transcribe: z.boolean().default(false),
      openai_apikey: z.string().max(300).optional(),
      download_quoted: z.boolean().default(false),
    }),
    req.body,
  );
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { row, msg } = await loadWaMessage(i.id, p.id);
  if (!canSeeLocked(req, i.id)) {
    const c = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: i.id, chatid: row.chatid } }, select: { locked: true } });
    if (c?.locked) throw forbidden('Conversa trancada: confirme sua senha para abrir');
  }

  let target: WAMessage = msg;
  if (p.download_quoted) {
    const inner = unwrap(msg.message as Record<string, unknown>);
    const quoted = (inner[contentType(inner)] as { contextInfo?: { quotedMessage?: unknown; stanzaId?: string } } | undefined)?.contextInfo;
    if (!quoted?.quotedMessage) throw badRequest('A mensagem não cita outra mensagem com mídia');
    target = { key: { ...msg.key, id: quoted.stanzaId }, message: quoted.quotedMessage } as WAMessage;
  }
  const type = contentType(target.message as Record<string, unknown>);
  if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'].includes(type)) {
    throw badRequest('A mensagem não contém mídia');
  }
  const inner = unwrap(target.message as Record<string, unknown>)[type] as { mimetype?: string; url?: string; directPath?: string };
  const host = mediaDownloadHost(inner);
  let buffer = (await downloadMediaMessage(target, 'buffer', host ? { host } : {}, { logger: silent, reuploadRequest: session.sock!.updateMediaMessage })) as Buffer;
  let mimetype = inner?.mimetype?.split(';')[0] ?? 'application/octet-stream';
  const originalAudio = type === 'audioMessage' ? { buffer, mimetype } : undefined;
  if (type === 'audioMessage' && p.generate_mp3) {
    buffer = await toMp3(buffer);
    mimetype = 'audio/mpeg';
  }
  const fileURL = await storeFile(buffer, mimetype);

  let transcription: string | undefined;
  if (p.transcribe) {
    if (!originalAudio) throw badRequest('Transcrição disponível apenas para áudio');
    const key = p.openai_apikey || decField(i.openaiApiKeyEnc, `openai:${i.id}`) || env.OPENAI_API_KEY || '';
    transcription = await transcribe(buffer, mimetype, key);
  }
  await prisma.message.update({ where: { id: row.id }, data: { fileURL, ...(transcription ? { transcription } : {}) } });
  res.json({ fileURL, mimetype, ...(p.return_base64 ? { base64Data: buffer.toString('base64') } : {}), ...(transcription != null ? { transcription } : {}) });
});

messageRouter.post('/message/history-sync', async (req, res) => {
  const p = parse(z.object({ mode: z.enum(['history', 'exact']).default('history'), messageid: z.string().max(200).optional(), number: z.string().min(3).max(120), count: z.coerce.number().int().min(1).max(200).default(50) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { toJid } = await import('../lib/jid.js');
  const chatid = toJid(p.number);
  const anchor = p.messageid
    ? await prisma.message.findFirst({ where: { instanceId: i.id, chatid, messageid: p.messageid } })
    : await prisma.message.findFirst({ where: { instanceId: i.id, chatid }, orderBy: { messageTimestamp: 'asc' } });
  if (!anchor) throw conflict('Nenhuma mensagem local deste chat para usar como âncora do histórico');
  const requestId = await session.call<string>('fetchMessageHistory', p.count, keyOf(anchor), Math.floor(Number(anchor.messageTimestamp) / 1000));
  res.json({ success: true, mode: p.mode, message: 'Solicitação enviada ao aparelho principal; aguarde o evento history', details: { requestId, anchor: anchor.messageid } });
});

messageRouter.post('/message/markread', async (req, res) => {
  const { id } = parse(z.object({ id: z.array(z.string().max(200)).min(1).max(500) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const rows = await prisma.message.findMany({ where: { instanceId: i.id, OR: [{ id: { in: id } }, { messageid: { in: id } }] } });
  await session.sock!.readMessages(rows.map(keyOf));
  res.json({ results: rows.map((r) => ({ id: r.id, read: true })) });
});

messageRouter.post('/message/react', async (req, res) => {
  const p = parse(z.object({ number: z.string().max(120).optional(), text: z.string().max(20), id: z.string().min(1).max(200) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { row } = await loadWaMessage(i.id, p.id);
  const sent = await session.sock!.sendMessage(row.chatid, { react: { text: p.text, key: keyOf(row) } });
  await prisma.message.update({ where: { id: row.id }, data: { reaction: p.text } });
  res.json({ id: row.id, messageid: sent?.key.id, content: sent?.message, messageTimestamp: Number(sent?.messageTimestamp ?? 0), messageType: 'reactionMessage', status: 'Sent', owner: i.connectedPhone });
});

messageRouter.post('/message/delete', async (req, res) => {
  const { id, for_me: forMe } = parse(z.object({ id: z.string().min(1).max(200), for_me: z.boolean().default(false) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { row } = await loadWaMessage(i.id, id);
  if (forMe) {
    // "Apagar para mim": some deste aparelho/painel; o contato continua vendo.
    await session.sock!.chatModify({ deleteForMe: { deleteMedia: true, key: keyOf(row), timestamp: Math.floor(Number(row.messageTimestamp) / 1000) } } as never, row.chatid);
    await prisma.message.delete({ where: { id: row.id } });
    res.json({ timestamp: Date.now(), id: row.id, deleted: 'for_me' });
    return;
  }
  if (!row.fromMe && !row.isGroup) throw forbidden('Só é possível apagar para todos mensagens enviadas por esta conta');
  await session.sock!.sendMessage(row.chatid, { delete: keyOf(row) });
  await prisma.message.update({ where: { id: row.id }, data: { status: 'Deleted' } });
  res.json({ timestamp: Date.now(), id: row.id });
});

messageRouter.post('/message/edit', async (req, res) => {
  const { id, text } = parse(z.object({ id: z.string().min(1).max(200), text: z.string().min(1).max(65_000) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { row, msg } = await loadWaMessage(i.id, id);
  if (!row.fromMe) throw forbidden('Só é possível editar mensagens enviadas por esta conta');
  // A edição vai sempre como texto: em foto/vídeo/documento o WhatsApp marca "editada" sem trocar a legenda.
  if (!TEXT_TYPES.has(contentType(msg.message as Record<string, unknown>))) throw badRequest('Só é possível corrigir mensagens de texto');
  // Chave ORIGINAL da mensagem (pode ser @lid); a remontada pelo chatid aponta para outra conversa
  // depois da fusão LID → número e o WhatsApp do cliente ignora a edição.
  const key: WAMessageKey = msg.key?.id
    ? { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: true, ...(msg.key.participant ? { participant: msg.key.participant } : {}) }
    : keyOf(row);
  const sent = await session.sock!.sendMessage(key.remoteJid || row.chatid, { text, edit: key });
  await prisma.message.update({ where: { id: row.id }, data: { text, edited: text } });
  res.json({ id: row.id, messageid: row.messageid, content: sent?.message, messageTimestamp: Number(sent?.messageTimestamp ?? 0), messageType: row.messageType, status: row.status, owner: i.connectedPhone });
});

messageRouter.post('/message/pin', async (req, res) => {
  // duration em dias (WhatsApp aceita 1, 7 ou 30).
  const p = parse(z.object({ id: z.string().min(1).max(200), pin: z.boolean().default(true), duration: z.coerce.number().int().min(1).default(30) }), req.body);
  const i = inst(req);
  const session = await SessionManager.requireConnected(i);
  const { row } = await loadWaMessage(i.id, p.id);
  const time = p.duration <= 1 ? 86400 : p.duration <= 7 ? 604800 : 2592000;
  await session.sock!.sendMessage(row.chatid, { pin: keyOf(row), type: p.pin ? 1 : 2, time } as never);
  const updated = await prisma.message.update({ where: { id: row.id }, data: { pinned: p.pin } });
  res.json({ ...presentMessage(updated, i.connectedPhone), targetMessageID: row.messageid, pinned: p.pin });
});

messageRouter.post('/message/payment/status', () => {
  throw notImplemented('Atualização de status de pedido/pagamento não é suportada pelo Baileys');
});
