import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { tooMany } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createRedisConnection } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { redis, rk } from '../lib/redis.js';
import { CHAT_SCOPED_EVENTS, chatKey, EVENT_TYPES, eventBus, isExcluded, type WaEvent } from '../whatsapp/eventBus.js';

/**
 * Server-Sent Events para dashboards em tempo real.
 * Eventos trafegam por Redis pub/sub, então o cliente SSE pode estar conectado em
 * qualquer réplica, independentemente do nó que hospeda a sessão WhatsApp.
 */

const MAX_PER_INSTANCE = 10; // painéis do dono / integrações
const MAX_PER_AGENT = 3; // cada atendente tem as próprias vagas (não tira as do dono)
const pub = createRedisConnection('sse-pub');
const sub = createRedisConnection('sse-sub');
const channel = (id: string) => `nwa:ev:${id}`;

interface Client {
  res: Response;
  events: Set<string>;
  exclude: string[];
  /** Atendente: só recebe eventos das conversas atribuídas a ele. */
  agent?: { userId: string; chats: Set<string> };
}

// Atendente vê só: mensagens/entrega/digitando/chamadas das conversas dele, atribuições
// e o estado da conexão. Contatos, histórico, grupos, etiquetas e campanhas não.
const AGENT_EVENTS = new Set(['messages', 'messages_update', 'presence', 'call', 'chats', 'connection']);

function agentAllows(c: Client, e: WaEvent): boolean {
  if (!c.agent) return true;
  if (!AGENT_EVENTS.has(e.eventType)) return false;
  if (e.eventType === 'connection') return true;
  // Atribuição nova para este atendente: passa a acompanhar a conversa na hora.
  const ev = (e.payload.event ?? {}) as { type?: string; lead_assignedAttendant_id?: string };
  if (e.eventType === 'chats' && ev.type === 'assignment' && e.meta.chatid) {
    if (ev.lead_assignedAttendant_id === c.agent.userId) c.agent.chats.add(chatKey(e.meta.chatid));
    else c.agent.chats.delete(chatKey(e.meta.chatid));
    return ev.lead_assignedAttendant_id === c.agent.userId;
  }
  if (!CHAT_SCOPED_EVENTS.has(e.eventType) && e.eventType !== 'chats') return false;
  const keys = [e.meta.chatid, e.meta.chatlid].filter((v): v is string => Boolean(v)).map(chatKey);
  return keys.some((k) => c.agent!.chats.has(k));
}

// Presença dos atendentes: "online" = painel aberto (stream SSE ativo). Chave com TTL
// renovada no heartbeat; fechar a aba ou cair a rede apaga em até ~1 min.
const onlineKey = (instanceId: string, userId: string) => rk('online', instanceId, userId);
async function markOnline(instanceId: string, userId: string): Promise<void> {
  await redis.set(onlineKey(instanceId, userId), '1', 'EX', 60).catch(() => undefined);
}
export async function onlineAgents(instanceId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const vals = await redis.mget(...userIds.map((u) => onlineKey(instanceId, u))).catch(() => [] as Array<string | null>);
  return new Set(userIds.filter((_, idx) => vals[idx] === '1'));
}

async function loadAgentChats(instanceId: string, userId: string): Promise<Set<string>> {
  const rows = await prisma.chat.findMany({ where: { instanceId, leadAssignedAttendantId: userId }, select: { chatid: true, chatlid: true }, take: 5000 });
  const set = new Set<string>();
  for (const r of rows) {
    set.add(chatKey(r.chatid));
    if (r.chatlid) set.add(chatKey(r.chatlid));
  }
  return set;
}
const clients = new Map<string, Set<Client>>();

export function startSseHub(): void {
  eventBus.on('event', (e: WaEvent) => {
    void pub.publish(channel(e.instanceId), JSON.stringify(e)).catch(() => undefined);
  });
  sub.on('message', (ch: string, raw: string) => {
    const id = ch.slice('nwa:ev:'.length);
    const set = clients.get(id);
    if (!set?.size) return;
    const e = JSON.parse(raw) as WaEvent;
    const data = JSON.stringify({ EventType: e.eventType, instanceId: e.instanceId, BaseUrl: env.PUBLIC_URL, ...e.payload });
    let agentData: string | undefined;
    for (const c of set) {
      if (c.events.size && !c.events.has(e.eventType)) continue;
      if (isExcluded(e.meta, c.exclude)) continue;
      if (!agentAllows(c, e)) continue;
      if (c.agent && e.eventType === 'connection') {
        // Atendente só precisa saber se o número está conectado. Nunca QR code/código de
        // pareamento (poderia parear o número num aparelho dele) nem campos administrativos.
        agentData ??= JSON.stringify({ EventType: 'connection', instanceId: e.instanceId, instance: { id: e.instanceId, status: (e.payload.instance as { status?: string } | undefined)?.status ?? '' } });
        c.res.write(`event: connection\ndata: ${agentData}\n\n`);
        continue;
      }
      c.res.write(`event: ${e.eventType}\ndata: ${data}\n\n`);
    }
  });
}

export async function handleSse(req: Request, res: Response, instanceId: string, agentUserId?: string): Promise<void> {
  const set = clients.get(instanceId) ?? new Set<Client>();
  const count = [...set].filter((c) => (agentUserId ? c.agent?.userId === agentUserId : !c.agent)).length;
  if (count >= (agentUserId ? MAX_PER_AGENT : MAX_PER_INSTANCE)) throw tooMany('Limite de conexões SSE atingido');

  const events = new Set(
    String(req.query.events ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => (EVENT_TYPES as readonly string[]).includes(s)),
  );
  const exclude = String(req.query.excludeMessages ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx não deve bufferizar o stream
  });
  res.flushHeaders();
  res.write(`event: ready\ndata: {"instanceId":"${instanceId}"}\n\n`);

  const client: Client = { res, events, exclude };
  let refresh: NodeJS.Timeout | undefined;
  if (agentUserId) {
    client.agent = { userId: agentUserId, chats: await loadAgentChats(instanceId, agentUserId) };
    // Recarrega periodicamente (transferências feitas em outra réplica) e revalida o acesso:
    // atendente removido/desativado perde o stream na hora, sem esperar o token expirar.
    refresh = setInterval(() => {
      void (async () => {
        const link = await prisma.instanceAgent.findFirst({ where: { instanceId, userId: agentUserId, active: true, user: { isActive: true } }, select: { id: true } });
        if (!link) return res.end();
        client.agent!.chats = await loadAgentChats(instanceId, agentUserId);
      })().catch(() => undefined);
    }, 20_000);
  }
  if (!clients.has(instanceId)) {
    clients.set(instanceId, set);
    await sub.subscribe(channel(instanceId));
  }
  set.add(client);

  if (agentUserId) await markOnline(instanceId, agentUserId);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
    if (agentUserId) void markOnline(instanceId, agentUserId);
  }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(refresh);
    // Última aba do atendente fechada → offline na hora (sem esperar o TTL).
    if (agentUserId && ![...(clients.get(instanceId) ?? [])].some((c) => c.agent?.userId === agentUserId)) {
      void redis.del(onlineKey(instanceId, agentUserId)).catch(() => undefined);
    }
    set.delete(client);
    if (!set.size) {
      clients.delete(instanceId);
      void sub.unsubscribe(channel(instanceId)).catch((err: Error) => logger.warn({ err: err.message }, 'sse unsubscribe'));
    }
  });
}
