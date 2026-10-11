import type { Instance } from '@prisma/client';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { randomInt } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { createRedisConnection } from '../lib/redis.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { presentMessage } from '../whatsapp/presenters.js';
import { rowId } from '../whatsapp/store.js';
import { executeSend, newMessageId } from './sendService.js';
import type { SendKind } from './sendSchemas.js';

/**
 * Fila assíncrona de envio direto (`async: true`), uma fila BullMQ por instância.
 * Por quê: absorve picos sem manter a requisição HTTP aberta, serializa os envios
 * de cada número (concorrência 1) e aplica o intervalo aleatório configurado — ritmo
 * humano reduz o risco de o WhatsApp restringir o número. A fila é persistida no Redis,
 * então sobrevive a reinícios do processo.
 */

interface AsyncJob {
  instanceId: string;
  kind: SendKind;
  payload: Record<string, unknown>;
  messageId: string;
  trackSource?: string;
  trackId?: string;
}

const connection = createRedisConnection('async-queue');
const queues = new Map<string, Queue<AsyncJob>>();
const workers = new Map<string, Worker<AsyncJob>>();
const qname = (id: string) => `async-${id}`;

function queueFor(instanceId: string): Queue<AsyncJob> {
  let q = queues.get(instanceId);
  if (!q) {
    q = new Queue<AsyncJob>(qname(instanceId), { connection, prefix: 'nwa:bull' });
    // Sem listener, um erro de conexão Redis viraria exceção não tratada e derrubaria o processo.
    q.on('error', (err: Error) => logger.error({ err: err.message, instance: instanceId }, 'async queue error'));
    queues.set(instanceId, q);
  }
  return q;
}

export function ensureAsyncWorker(instanceId: string): void {
  if (workers.has(instanceId)) return;
  const worker = new Worker<AsyncJob>(
    qname(instanceId),
    async (job: Job<AsyncJob>, token?: string) => {
      const instance = await prisma.instance.findUnique({ where: { id: job.data.instanceId } });
      if (!instance) return; // instância removida: descarta
      const session = SessionManager.get(instance.id);
      if (!session?.isConnected) {
        // Sessão indisponível: adia sem consumir tentativa.
        await job.moveToDelayed(Date.now() + 10_000, token);
        throw new DelayedError();
      }
      await executeSend(instance, job.data.kind, job.data.payload, {
        sendFunction: `async:${job.data.kind}`,
        trackSource: job.data.trackSource,
        trackId: job.data.trackId,
        messageId: job.data.messageId,
      });
      // Intervalo entre mensagens (msg_delay_min/max em segundos).
      const wait = randomInt(instance.msgDelayMin, Math.max(instance.msgDelayMin, instance.msgDelayMax)) * 1000;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
    { connection: createRedisConnection(`async-worker-${instanceId}`), prefix: 'nwa:bull', concurrency: 1 },
  );
  worker.on('error', (err: Error) => logger.error({ err: err.message, instance: instanceId }, 'async worker error'));
  worker.on('failed', (job, err) => {
    if (!job || err instanceof DelayedError) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void prisma.message
        .updateMany({ where: { instanceId: job.data.instanceId, messageid: job.data.messageId }, data: { status: 'Failed', error: err.message.slice(0, 500) } })
        .catch(() => undefined);
    }
    logger.warn({ instance: job.data.instanceId, err: err.message }, 'envio async falhou');
  });
  workers.set(instanceId, worker);
}

export async function enqueueSend(instance: Instance, kind: SendKind, payload: Record<string, unknown>) {
  if (!instance.connectedPhone) throw conflict('A instância precisa ter sido conectada ao menos uma vez para usar async');
  // O job fica no Redis (memória): mídia em base64 inline esgotaria o Redis rapidamente.
  if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) {
    throw badRequest('Com async=true envie a mídia por URL (payload máximo de 256 KB na fila)');
  }
  const messageId = newMessageId();
  const { async: _a, ...clean } = payload;
  const trackSource = typeof payload.track_source === 'string' ? payload.track_source : '';
  const trackId = typeof payload.track_id === 'string' ? payload.track_id : '';
  const row = await prisma.message.create({
    data: {
      id: rowId(instance.connectedPhone, messageId),
      instanceId: instance.id,
      messageid: messageId,
      chatid: String(payload.number ?? ''),
      fromMe: true,
      status: 'Queued',
      wasSentByApi: true,
      sendFunction: `async:${kind}`,
      trackSource,
      trackId,
      text: typeof payload.text === 'string' ? payload.text.slice(0, 1000) : '',
      messageTimestamp: BigInt(Date.now()),
    },
  });
  const q = queueFor(instance.id);
  ensureAsyncWorker(instance.id);
  // jobId = messageId → reenfileirar o mesmo ID é idempotente no BullMQ.
  await q.add('send', { instanceId: instance.id, kind, payload: clean, messageId, trackSource, trackId }, {
    jobId: messageId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
  const counts = await q.getJobCounts('waiting', 'delayed');
  return { ...presentMessage(row, instance.connectedPhone), async: true, queuePosition: (counts.waiting ?? 0) + (counts.delayed ?? 0) };
}

export async function asyncStatus(instance: Instance) {
  const q = queueFor(instance.id);
  const c = await q.getJobCounts('waiting', 'delayed', 'active', 'paused');
  const pending = (c.waiting ?? 0) + (c.delayed ?? 0) + (c.paused ?? 0);
  const sessionReady = Boolean(SessionManager.get(instance.id)?.isConnected);
  const status = (c.active ?? 0) > 0 ? 'processing' : pending === 0 ? 'idle' : sessionReady ? 'queued' : 'waiting_connection';
  return {
    response: 'ok',
    instanceId: instance.id,
    queue: { status, pending, processingNow: (c.active ?? 0) > 0, acceptingNewMessages: true, sessionReady, historyReady: true, warmupRemainingMs: 0, resetting: false },
  };
}

export async function clearAsync(instance: Instance) {
  const q = queueFor(instance.id);
  const before = await q.getJobCounts('waiting', 'delayed');
  await q.drain(true);
  const canceled = await prisma.message.updateMany({ where: { instanceId: instance.id, status: 'Queued' }, data: { status: 'Canceled' } });
  return {
    response: 'Fila limpa',
    instanceId: instance.id,
    stats: { trackedJobsCleared: (before.waiting ?? 0) + (before.delayed ?? 0), bufferedJobsMarkedCanceled: 0, drainedChannelJobs: 0, clearedOverflowJobs: 0, persistedQueuedCanceled: canceled.count },
  };
}

export async function removeInstanceQueue(instanceId: string): Promise<void> {
  await workers.get(instanceId)?.close();
  workers.delete(instanceId);
  const q = queueFor(instanceId);
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
  queues.delete(instanceId);
}

export async function closeAsyncQueues(): Promise<void> {
  await Promise.allSettled([...workers.values()].map((w) => w.close()));
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
}
