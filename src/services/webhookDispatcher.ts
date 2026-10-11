import type { GlobalWebhook, Webhook } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { CircuitBreaker } from '../lib/circuitBreaker.js';
import { signWebhook } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { webhookDeliveries } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { createRedisConnection, redis, rk } from '../lib/redis.js';
import { RedisBreakerStore } from '../lib/redisStores.js';
import { decField } from '../lib/security.js';
import { safeFetch } from '../lib/ssrf.js';
import { buildWebhookUrl, chatAllowed, eventBus, isExcluded, type WaEvent } from '../whatsapp/eventBus.js';

/**
 * Entrega de webhooks: produtor (escuta o eventBus) + consumidor (worker BullMQ).
 *
 * Confiabilidade: fila persistente no Redis, 6 tentativas com backoff exponencial,
 * circuit breaker por destino e registro dos últimos erros (/webhook/errors).
 * Segurança: destino validado contra SSRF a cada entrega; corpo assinado com
 * HMAC-SHA256 (header X-NexusWA-Signature). Diferente da uazapi, o token da
 * instância NÃO vai no payload — assinatura substitui a necessidade de enviá-lo.
 */

interface DeliveryJob {
  scope: string; // instanceId, "user:<id>" (webhook da conta) ou "global"
  webhookId: string;
  url: string;
  body: string;
  eventType: string;
  messageType?: string;
}

const MESSAGE_EVENTS = new Set(['messages', 'messages_update', 'newsletter_messages']);
const connection = createRedisConnection('webhook-queue');
const queue = new Queue<DeliveryJob>('webhooks', { connection, prefix: 'nwa:bull' });
queue.on('error', (err: Error) => logger.error({ err: err.message }, 'webhook queue error'));
const breaker = new CircuitBreaker(new RedisBreakerStore(), { failureThreshold: 5, cooldownMs: 60_000 });

type HookCfg = Pick<Webhook, 'id' | 'url' | 'enabled' | 'events' | 'excludeMessages' | 'addUrlEvents' | 'addUrlTypesMessages' | 'secretEnc'> & { onlyChats?: string[] | null };
const cache = new Map<string, { at: number; hooks: HookCfg[] }>();
let globalCache: { at: number; hook: GlobalWebhook | null } | undefined;
const TTL = 30_000;

const userCache = new Map<string, { at: number; hooks: HookCfg[] }>();
export function invalidateUserWebhookCache(userId: string): void {
  userCache.delete(userId);
}
async function userHooksFor(userId: string): Promise<HookCfg[]> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return hit.hooks;
  const hooks = await prisma.userWebhook.findMany({ where: { userId, enabled: true } });
  userCache.set(userId, { at: Date.now(), hooks });
  return hooks;
}

export function invalidateWebhookCache(instanceId?: string): void {
  if (instanceId) cache.delete(instanceId);
  else globalCache = undefined;
}

async function hooksFor(instanceId: string): Promise<HookCfg[]> {
  const hit = cache.get(instanceId);
  if (hit && Date.now() - hit.at < TTL) return hit.hooks;
  const hooks = await prisma.webhook.findMany({ where: { instanceId, enabled: true } });
  cache.set(instanceId, { at: Date.now(), hooks });
  return hooks;
}

async function globalHook(): Promise<GlobalWebhook | null> {
  if (globalCache && Date.now() - globalCache.at < TTL) return globalCache.hook;
  const hook = await prisma.globalWebhook.findUnique({ where: { id: 'global' } });
  globalCache = { at: Date.now(), hook };
  return hook;
}

export const secretAad = (scope: string, webhookId: string) => `webhook:${scope}:${webhookId}`;

function wants(h: { events: string[]; excludeMessages: string[]; onlyChats?: string[] | null }, e: WaEvent): boolean {
  if (h.events.length && !h.events.includes(e.eventType)) return false;
  if (!chatAllowed(e.eventType, e.meta, h.onlyChats ?? [])) return false;
  if (MESSAGE_EVENTS.has(e.eventType) && isExcluded(e.meta, h.excludeMessages)) return false;
  return true;
}

async function onEvent(e: WaEvent): Promise<void> {
  const instance = await prisma.instance.findUnique({ where: { id: e.instanceId }, select: { name: true, connectedPhone: true, ownerId: true } });
  if (!instance) return;
  const body = JSON.stringify({
    EventType: e.eventType,
    owner: instance.connectedPhone,
    BaseUrl: env.PUBLIC_URL,
    instanceName: instance.name,
    instanceId: e.instanceId,
    timestamp: e.at,
    ...e.payload,
  });
  // Três níveis: da instância (número), da conta do dono (todas as instâncias dele) e global (servidor).
  const targets: Array<{ scope: string; hook: HookCfg }> = (await hooksFor(e.instanceId)).map((hook) => ({ scope: e.instanceId, hook }));
  if (instance.ownerId) {
    for (const hook of await userHooksFor(instance.ownerId)) targets.push({ scope: `user:${instance.ownerId}`, hook });
  }
  const g = await globalHook();
  if (g?.enabled) targets.push({ scope: 'global', hook: { ...g, id: 'global' } });

  for (const { scope, hook } of targets) {
    if (!wants(hook, e)) continue;
    await queue.add(
      e.eventType,
      { scope, webhookId: hook.id, url: buildWebhookUrl(hook.url, e.eventType, e.meta.messageType, hook), body, eventType: e.eventType, messageType: e.meta.messageType },
      { attempts: 6, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 500, removeOnFail: 2000 },
    );
  }
}

async function recordError(job: Job<DeliveryJob>, statusCode: number, error: string): Promise<void> {
  const key = rk('wherr', job.data.scope);
  const entry = {
    created: new Date().toISOString(),
    url: job.data.url,
    type: 'delivery',
    event: job.data.eventType,
    message_type: job.data.messageType ?? '',
    status_code: statusCode,
    attempts: job.attemptsMade + 1,
    error: error.slice(0, 300),
    payload: job.data.body.slice(0, 2000),
  };
  await redis.multi().lpush(key, JSON.stringify(entry)).ltrim(key, 0, 99).expire(key, 7 * 86400).set(`${key}:since`, new Date().toISOString(), 'NX').exec();
}

export async function webhookErrors(scope: string): Promise<{ since: string | null; errors: unknown[] }> {
  const key = rk('wherr', scope);
  const [list, since] = await Promise.all([redis.lrange(key, 0, 99), redis.get(`${key}:since`)]);
  return { since, errors: list.map((s) => JSON.parse(s) as unknown) };
}

async function secretFor(scope: string, webhookId: string): Promise<string> {
  if (scope === 'global') {
    const g = await globalHook();
    return decField(g?.secretEnc, secretAad('global', 'global'));
  }
  if (scope.startsWith('user:')) {
    const userHook = await prisma.userWebhook.findFirst({ where: { id: webhookId, userId: scope.slice(5) }, select: { secretEnc: true } });
    if (!userHook) throw new Error('webhook removido');
    return decField(userHook.secretEnc, secretAad(scope, webhookId));
  }
  const hook = await prisma.webhook.findFirst({ where: { id: webhookId, instanceId: scope }, select: { secretEnc: true } });
  if (!hook) throw new Error('webhook removido');
  return decField(hook.secretEnc, secretAad(scope, webhookId));
}

let worker: Worker<DeliveryJob> | undefined;

export function startWebhookDispatcher(): void {
  eventBus.on('event', (e: WaEvent) => void onEvent(e).catch((err) => logger.error({ err: (err as Error).message }, 'falha ao enfileirar webhook')));

  worker = new Worker<DeliveryJob>(
    'webhooks',
    async (job) => {
      const origin = new URL(job.data.url).origin;
      const blocked = await breaker.blockedFor(origin);
      if (blocked > 0) throw new Error(`circuito aberto para ${origin} (${Math.ceil(blocked / 1000)}s)`);

      let secret: string;
      try {
        secret = await secretFor(job.data.scope, job.data.webhookId);
      } catch {
        return; // webhook foi removido depois do enfileiramento
      }
      const ts = Math.floor(Date.now() / 1000);
      let status = 0;
      try {
        const res = await safeFetch(job.data.url, {
          method: 'POST',
          body: job.data.body,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          maxRedirects: 0,
          allowPrivate: env.SSRF_ALLOW_PRIVATE || env.WEBHOOK_INTERNAL_HOSTS.has(new URL(job.data.url).hostname.toLowerCase()),
          headers: {
            'content-type': 'application/json',
            'x-nexuswa-event': job.data.eventType,
            'x-nexuswa-delivery': String(job.id),
            'x-nexuswa-signature': signWebhook(secret, job.data.body, ts),
          },
        });
        status = res.status;
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
        await breaker.success(origin);
        webhookDeliveries.inc({ result: 'ok' });
      } catch (err) {
        const { opened } = await breaker.failure(origin);
        webhookDeliveries.inc({ result: 'error' });
        if (opened) logger.warn({ origin }, 'circuit breaker aberto para destino de webhook');
        await recordError(job, status, (err as Error).message);
        throw err;
      }
    },
    { connection: createRedisConnection('webhook-worker'), prefix: 'nwa:bull', concurrency: 20 },
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'webhook worker'));
}

export async function stopWebhookDispatcher(): Promise<void> {
  await worker?.close();
  await queue.close();
}
