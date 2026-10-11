import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { idempotency } from '../middlewares/idempotency.js';
import { campaignStats } from '../services/campaignWorker.js';
import { SCHEMAS, campaignKind } from '../services/sendSchemas.js';
import { SessionManager } from '../whatsapp/SessionManager.js';

/**
 * Campanhas / envio em massa.
 * Proteções de negócio: limite de destinatários por campanha, intervalo mínimo entre
 * mensagens (ritmo humano) e validação de CADA mensagem na criação — erros aparecem
 * antes do disparo, não no meio da campanha.
 */
export const senderRouter = Router();

const MAX_MESSAGES = 10_000;
const MIN_DELAY_SEC = 3;

/** scheduled_for: timestamp em ms, ou minutos a partir de agora se < 10^10 (regra uazapi). */
function resolveSchedule(v: number | undefined): bigint {
  if (!v) return BigInt(Date.now());
  return BigInt(v < 1e10 ? Date.now() + v * 60_000 : v);
}

const CAMPAIGN_TYPES = ['text', 'image', 'video', 'videoplay', 'audio', 'document', 'ptt', 'myaudio', 'sticker', 'contact', 'location', 'list', 'button', 'poll', 'carousel'] as const;

/** Valida o payload de uma mensagem de campanha usando o MESMO schema do envio direto. */
function validateItem(type: string, item: Record<string, unknown>, idx: number): Record<string, unknown> {
  const kind = campaignKind(type);
  const payload: Record<string, unknown> = { ...item };
  if (kind === 'media') payload.type = type;
  if (kind === 'menu') {
    payload.type = type;
    if (!payload.text) payload.text = ' ';
  }
  const r = SCHEMAS[kind].safeParse(payload);
  if (!r.success) throw badRequest(`Mensagem ${idx}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  toJid(String(payload.number));
  const { number: _n, async: _a, ...rest } = r.data as Record<string, unknown>;
  return rest;
}

async function createFolder(instanceId: string, info: string, delayMin: number, delayMax: number, scheduledFor: bigint, items: Array<{ number: string; type: string; payload: Record<string, unknown> }>) {
  if (delayMax < delayMin) throw badRequest('delayMax deve ser >= delayMin');
  if (delayMin < MIN_DELAY_SEC) throw badRequest(`delayMin mínimo é ${MIN_DELAY_SEC}s (proteção contra banimento)`);
  const folder = await prisma.$transaction(async (tx) => {
    const f = await tx.campaignFolder.create({
      data: { instanceId, info, delayMin, delayMax, scheduledFor, nextSendAt: scheduledFor, logTotal: items.length, status: 'scheduled' },
    });
    // Inserção em lotes: 10k linhas em um único INSERT estouraria o limite de parâmetros do Postgres.
    for (let i = 0; i < items.length; i += 1000) {
      await tx.campaignMessage.createMany({
        data: items.slice(i, i + 1000).map((m, j) => ({ instanceId, folderId: f.id, position: i + j, number: m.number, type: m.type, payload: m.payload as Prisma.InputJsonValue })),
      });
    }
    return f;
  }, { timeout: 120_000, maxWait: 10_000 });
  return { folder_id: folder.id, count: items.length, status: 'queued' };
}

senderRouter.post('/sender/simple', idempotency, async (req, res) => {
  const body = parse(
    z
      .object({
        numbers: z.array(z.string().max(120)).min(1).max(MAX_MESSAGES),
        type: z.enum(CAMPAIGN_TYPES),
        folder: z.string().max(200).optional(),
        info: z.string().max(500).optional(),
        delayMin: z.coerce.number().int().min(0).max(3600),
        delayMax: z.coerce.number().int().min(0).max(3600),
        scheduled_for: z.coerce.number().int().min(0).optional(),
      })
      .passthrough(),
    req.body,
  );
  const { numbers, type, folder, info, delayMin, delayMax, scheduled_for, ...content } = body;
  const unique = [...new Set(numbers.map((n) => n.trim()))];
  const items = unique.map((number, idx) => ({ number: String(number), type: String(type), payload: validateItem(type, { ...content, number }, idx) }));
  res.json(await createFolder(inst(req).id, info ?? folder ?? '', delayMin, delayMax, resolveSchedule(scheduled_for), items));
});

senderRouter.post('/sender/advanced', idempotency, async (req, res) => {
  const body = parse(
    z.object({
      delayMin: z.coerce.number().int().min(0).max(3600).default(10),
      delayMax: z.coerce.number().int().min(0).max(3600).default(30),
      info: z.string().max(500).optional(),
      scheduled_for: z.coerce.number().int().min(0).optional(),
      messages: z.array(z.object({ number: z.string().max(120), type: z.enum(CAMPAIGN_TYPES) }).passthrough()).min(1).max(MAX_MESSAGES),
    }),
    req.body,
  );
  const items = body.messages.map((m, idx) => ({ number: String(m.number), type: String(m.type), payload: validateItem(m.type, m, idx) }));
  res.json(await createFolder(inst(req).id, body.info ?? '', body.delayMin, body.delayMax, resolveSchedule(body.scheduled_for), items));
});

senderRouter.post('/sender/edit', async (req, res) => {
  const p = parse(z.object({ folder_id: z.string().uuid(), action: z.enum(['stop', 'continue', 'delete']) }), req.body);
  const instanceId = inst(req).id;
  const folder = await prisma.campaignFolder.findFirst({ where: { id: p.folder_id, instanceId } });
  if (!folder) throw notFound('Campanha não encontrada');
  if (p.action === 'stop') {
    await prisma.campaignFolder.update({ where: { id: folder.id }, data: { status: 'paused' } });
    res.json({ status: 'paused' });
  } else if (p.action === 'continue') {
    await prisma.campaignFolder.update({ where: { id: folder.id }, data: { status: 'scheduled', nextSendAt: BigInt(Date.now()) } });
    res.json({ status: 'scheduled', message: 'Campanha retomada' });
  } else {
    // Remove pendentes, preserva histórico do que já foi enviado.
    await prisma.$transaction([
      prisma.campaignFolder.update({ where: { id: folder.id }, data: { status: 'deleting' } }),
      prisma.campaignMessage.deleteMany({ where: { folderId: folder.id, status: 'Scheduled' } }),
    ]);
    res.json({ status: 'deleting', message: 'Folder deletion has been initiated' });
  }
});

senderRouter.post('/sender/cleardone', async (req, res) => {
  const { hours } = parse(z.object({ hours: z.coerce.number().int().min(1).max(8760).default(168) }), req.body);
  const r = await prisma.campaignFolder.deleteMany({ where: { instanceId: inst(req).id, status: { in: ['done', 'deleting'] }, updatedAt: { lt: new Date(Date.now() - hours * 3600_000) } } });
  res.json({ status: 'ok', folders_deleted: r.count });
});

senderRouter.delete('/sender/clearall', async (req, res) => {
  const instanceId = inst(req).id;
  const [messages, folders] = await prisma.$transaction([
    prisma.campaignMessage.deleteMany({ where: { instanceId } }),
    prisma.campaignFolder.deleteMany({ where: { instanceId } }),
  ]);
  res.json({ status: 'ok', messages_deleted: messages.count, folders_deleted: folders.count });
});

senderRouter.get('/sender/listfolders', async (req, res) => {
  const status = req.query.status === 'Archived' ? ['done', 'deleting'] : req.query.status === 'Active' ? ['scheduled', 'sending', 'paused'] : undefined;
  const i = inst(req);
  const folders = await prisma.campaignFolder.findMany({ where: { instanceId: i.id, ...(status ? { status: { in: status } } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 });
  res.json(
    folders.map((f) => ({
      id: f.id,
      info: f.info,
      status: f.status,
      scheduled_for: Number(f.scheduledFor),
      delayMin: f.delayMin,
      delayMax: f.delayMax,
      log_delivered: f.logDelivered,
      log_failed: f.logFailed,
      log_played: f.logPlayed,
      log_read: f.logRead,
      log_sucess: f.logSuccess,
      log_total: f.logTotal,
      owner: i.connectedPhone,
      created: f.createdAt,
      updated: f.updatedAt,
    })),
  );
});

senderRouter.post('/sender/listmessages', async (req, res) => {
  const p = parse(z.object({ folder_id: z.string().uuid(), messageStatus: z.enum(['Scheduled', 'Sent', 'Failed']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(1000), offset: z.coerce.number().int().min(0).default(0) }), req.body);
  const instanceId = inst(req).id;
  const where = { instanceId, folderId: p.folder_id, ...(p.messageStatus ? { status: p.messageStatus } : {}) };
  const [rows, total] = await Promise.all([prisma.campaignMessage.findMany({ where, orderBy: { position: 'asc' }, skip: p.offset, take: p.limit }), prisma.campaignMessage.count({ where })]);
  res.json({ messages: rows.map((m) => ({ id: m.id, number: m.number, type: m.type, status: m.status, error: m.error, messageid: m.messageid, sentAt: m.sentAt })), pagination: { totalRecords: total, limit: p.limit, offset: p.offset } });
});

senderRouter.get('/sender/stats', async (req, res) => {
  const i = inst(req);
  const s = campaignStats(i.id);
  const next = await prisma.campaignFolder.findFirst({ where: { instanceId: i.id, status: { in: ['scheduled', 'sending'] } }, orderBy: { nextSendAt: 'asc' } });
  const nextAt = next ? Number(next.nextSendAt > next.scheduledFor ? next.nextSendAt : next.scheduledFor) : null;
  const inSec = nextAt ? Math.max(0, Math.round((nextAt - Date.now()) / 1000)) : null;
  res.json({
    status: 'success',
    data: {
      status: { current: s.current, direct_message_active: false, current_folder_id: s.current_folder_id, delay_min: next?.delayMin ?? 0, delay_max: next?.delayMax ?? 0 },
      statistics: { messages_processed: s.messages_processed, avg_processing_ms: s.avg_processing_ms, messages_per_minute: s.messages_per_minute },
      instance: { is_business: i.isBusiness, platform: i.platform, system_name: i.systemName, profile_name: i.profileName, session_connected: Boolean(SessionManager.get(i.id)?.isConnected) },
      scheduling: { next_send_at: nextAt ? new Date(nextAt).toISOString().replace('T', ' ').slice(0, 19) : null, next_send_in_seconds: inSec !== null && inSec < 3600 ? inSec : null },
    },
  });
});
