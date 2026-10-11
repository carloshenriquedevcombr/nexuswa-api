import type { CampaignMessage } from '@prisma/client';
import { randomInt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { eventBus } from '../whatsapp/eventBus.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { campaignKind } from './sendSchemas.js';
import { executeSend } from './sendService.js';

/**
 * Processador de campanhas (/sender).
 *
 * Concorrência: cada mensagem é reivindicada com `FOR UPDATE SKIP LOCKED` dentro de um
 * UPDATE atômico — mesmo com várias réplicas rodando este loop, uma mensagem nunca é
 * enviada duas vezes. `nextSendAt` é gravado ANTES do envio, garantindo o intervalo
 * mínimo entre mensagens da mesma campanha.
 */

interface Stats {
  current: 'idle' | 'sending' | 'paused' | 'processing';
  folderId: string;
  processed: number;
  totalMs: number;
  since: number;
}
const stats = new Map<string, Stats>();
const inFlight = new Set<string>();
let timer: NodeJS.Timeout | undefined;
let running = false;

export function campaignStats(instanceId: string) {
  const s = stats.get(instanceId);
  const minutes = s ? Math.max(1, (Date.now() - s.since) / 60_000) : 1;
  return {
    current: s?.current ?? 'idle',
    current_folder_id: s?.folderId ?? '',
    messages_processed: s?.processed ?? 0,
    avg_processing_ms: s && s.processed ? Math.round(s.totalMs / s.processed) : 0,
    messages_per_minute: s ? Number((s.processed / minutes).toFixed(2)) : 0,
  };
}

async function claimNext(folderId: string): Promise<CampaignMessage | null> {
  const rows = await prisma.$queryRaw<CampaignMessage[]>`
    UPDATE "campaign_messages" SET "status" = 'Sending'
    WHERE "id" = (
      SELECT "id" FROM "campaign_messages"
      WHERE "folderId" = ${folderId} AND "status" = 'Scheduled'
      ORDER BY "position" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = BigInt(Date.now());
    const folders = await prisma.campaignFolder.findMany({
      where: { status: { in: ['scheduled', 'sending'] }, scheduledFor: { lte: now }, nextSendAt: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: 50,
    });
    const busyInstances = new Set<string>();
    for (const folder of folders) {
      // Uma campanha por instância por vez: evita rajadas paralelas no mesmo número.
      if (busyInstances.has(folder.instanceId) || inFlight.has(folder.id)) continue;
      const session = SessionManager.get(folder.instanceId);
      if (!session?.isConnected) continue;
      busyInstances.add(folder.instanceId);
      inFlight.add(folder.id);
      void processOne(folder.id, folder.instanceId, folder.delayMin, folder.delayMax)
        .catch((err: Error) => logger.error({ folder: folder.id, err: err.message }, 'falha no processamento da campanha'))
        .finally(() => inFlight.delete(folder.id));
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'campaign tick');
  } finally {
    running = false;
  }
}

async function processOne(folderId: string, instanceId: string, delayMin: number, delayMax: number): Promise<void> {
  const msg = await claimNext(folderId);
  if (!msg) {
    const pending = await prisma.campaignMessage.count({ where: { folderId, status: { in: ['Scheduled', 'Sending'] } } });
    if (!pending) {
      await prisma.campaignFolder.updateMany({ where: { id: folderId, status: { in: ['scheduled', 'sending'] } }, data: { status: 'done' } });
      stats.set(instanceId, { ...(stats.get(instanceId) ?? { processed: 0, totalMs: 0, since: Date.now() }), current: 'idle', folderId: '' });
      eventBus.publish({ instanceId, eventType: 'sender', payload: { event: { type: 'folder_done', folder_id: folderId } }, meta: {} });
    }
    return;
  }

  const wait = randomInt(delayMin, Math.max(delayMin, delayMax)) * 1000;
  await prisma.campaignFolder.update({ where: { id: folderId }, data: { status: 'sending', nextSendAt: BigInt(Date.now() + wait) } });
  const s = stats.get(instanceId) ?? { current: 'sending', folderId, processed: 0, totalMs: 0, since: Date.now() };
  s.current = 'sending';
  s.folderId = folderId;
  stats.set(instanceId, s);

  const started = Date.now();
  try {
    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
    const payload = { ...(msg.payload as Record<string, unknown>), number: msg.number };
    const result = await executeSend(instance, campaignKind(msg.type), payload, { sendFunction: 'sender', folderId });
    await prisma.$transaction([
      prisma.campaignMessage.update({ where: { id: msg.id }, data: { status: 'Sent', messageid: String(result.message.messageid ?? ''), sentAt: new Date() } }),
      prisma.campaignFolder.update({ where: { id: folderId }, data: { logSuccess: { increment: 1 } } }),
    ]);
    eventBus.publish({ instanceId, eventType: 'sender', payload: { event: { type: 'message_sent', folder_id: folderId, number: msg.number, messageid: result.message.messageid } }, meta: {} });
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    await prisma.$transaction([
      prisma.campaignMessage.update({ where: { id: msg.id }, data: { status: 'Failed', error } }),
      prisma.campaignFolder.update({ where: { id: folderId }, data: { logFailed: { increment: 1 } } }),
    ]);
    eventBus.publish({ instanceId, eventType: 'sender', payload: { event: { type: 'message_failed', folder_id: folderId, number: msg.number, error } }, meta: {} });
  } finally {
    s.processed += 1;
    s.totalMs += Date.now() - started;
  }
}

/** Recupera mensagens presas em "Sending" (processo morreu no meio do envio). */
async function recoverStuck(): Promise<void> {
  const stuck = await prisma.campaignMessage.updateMany({ where: { status: 'Sending' }, data: { status: 'Failed', error: 'Interrompido por reinício do servidor (não reenviado para evitar duplicidade)' } });
  if (stuck.count) logger.warn({ count: stuck.count }, 'mensagens de campanha interrompidas marcadas como Failed');
}

export async function startCampaignWorker(): Promise<void> {
  await recoverStuck();
  timer = setInterval(() => void tick(), 2000);
}

export function stopCampaignWorker(): void {
  clearInterval(timer);
}
