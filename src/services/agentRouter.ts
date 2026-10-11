import type { Instance } from '@prisma/client';
import { env } from '../config/env.js';
import { randomId } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { acquireLock, releaseLock } from '../lib/redisStores.js';
import { eventBus } from '../whatsapp/eventBus.js';

/**
 * Distribuição de conversas entre atendentes (vários usuários no mesmo número).
 *
 * Regras:
 *  - Só conversas individuais entram na fila (grupos, canais e status ficam de fora).
 *  - Cliente com atendimento ABERTO continua com o mesmo atendente.
 *  - Atendimento novo: volta para o último atendente dele, se estiver disponível
 *    (o cliente não precisa se reapresentar); senão, rodízio — recebe quem está há
 *    mais tempo sem receber (lastAssignedAt mais antigo).
 *  - Ninguém disponível (almoço, férias, fora do ar): a conversa fica na FILA
 *    (aberta, sem atendente) e é distribuída assim que alguém ficar disponível.
 *
 * Concorrência: a escolha roda sob um lock Redis por instância, então duas mensagens
 * simultâneas nunca pegam o mesmo "próximo da fila" nem abrem o chat duas vezes.
 */

export { availabilityLabel, inBreak, isAvailable, minutesInTz, pickAgent } from './agentRules.js';
import { pickAgent } from './agentRules.js';

// ---------------------------------------------------------------- cache "tem atendentes?"
const hasAgentsCache = new Map<string, { at: number; value: boolean }>();
export function invalidateAgents(instanceId: string): void {
  hasAgentsCache.delete(instanceId);
}
async function hasAgents(instanceId: string): Promise<boolean> {
  const hit = hasAgentsCache.get(instanceId);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = (await prisma.instanceAgent.count({ where: { instanceId, active: true, user: { isActive: true } } })) > 0;
  hasAgentsCache.set(instanceId, { at: Date.now(), value });
  return value;
}

async function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T | undefined> {
  const owner = randomId(12);
  const name = `assign:${instanceId}`;
  for (let i = 0; i < 40; i++) {
    if (await acquireLock(name, owner, 10_000)) {
      try {
        return await fn();
      } finally {
        await releaseLock(name, owner).catch(() => undefined);
      }
    }
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  }
  logger.warn({ instanceId }, 'distribuição: lock ocupado, tentativa adiada para a próxima varredura');
  return undefined;
}

function publishAssignment(instanceId: string, chatid: string, attendantId: string, reason: string): void {
  eventBus.publish({
    instanceId,
    eventType: 'chats',
    payload: { event: { type: 'assignment', chatid, lead_assignedAttendant_id: attendantId, lead_isTicketOpen: true, reason } },
    meta: { chatid },
  });
}

export type AssignResult = { outcome: 'kept' | 'assigned'; userId: string } | { outcome: 'queued' | 'skipped' | 'busy' };

/** Garante que a conversa tenha atendimento aberto e, se houver alguém disponível, um atendente. */
export async function assignChat(instanceId: string, chatid: string): Promise<AssignResult> {
  const r = await withInstanceLock<AssignResult>(instanceId, async () => {
    const chat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId, chatid } } });
    // Trancada pelo dono: não vai para atendentes (eles nem conseguem abrir).
    if (!chat || chat.isGroup || chat.locked) return { outcome: 'skipped' };
    // Login desativado conta como indisponível (não recebe conversa que não conseguiria abrir).
    const agents = await prisma.instanceAgent.findMany({ where: { instanceId, user: { isActive: true } } });
    const current = chat.leadAssignedAttendantId;
    const currentLink = agents.find((a) => a.userId === current && a.active);
    if (chat.leadIsTicketOpen && currentLink) return { outcome: 'kept', userId: current }; // atendimento em andamento

    // Aberto sem atendente válido, ou fechado → escolhe (preferindo o último atendente).
    const chosen = pickAgent(agents, current || undefined);
    const now = new Date();
    await prisma.chat.update({
      where: { id: chat.id },
      data: { leadIsTicketOpen: true, leadAssignedAttendantId: chosen?.userId ?? '' },
    });
    if (chosen) {
      await prisma.instanceAgent.update({ where: { id: chosen.id }, data: { lastAssignedAt: now } });
      publishAssignment(instanceId, chatid, chosen.userId, chosen.userId === current ? 'retorno' : 'rodizio');
      return { outcome: 'assigned', userId: chosen.userId };
    }
    if (!chat.leadIsTicketOpen) publishAssignment(instanceId, chatid, '', 'fila');
    return { outcome: 'queued' };
  });
  return r ?? { outcome: 'busy' }; // lock ocupado: a próxima varredura tenta de novo
}

/** Chamado pela sessão a cada lote de mensagens recebidas em tempo real. */
export async function onInboundChats(instance: Instance, chats: Array<{ chatid: string; fromMe: boolean; isGroup: boolean }>): Promise<void> {
  if (!(await hasAgents(instance.id))) return;
  const targets = new Set(
    chats.filter((c) => !c.fromMe && !c.isGroup && (c.chatid.endsWith('@s.whatsapp.net') || c.chatid.endsWith('@lid'))).map((c) => c.chatid),
  );
  for (const chatid of targets) {
    await assignChat(instance.id, chatid).catch((err: Error) => logger.error({ err: err.message, instance: instance.id }, 'falha ao distribuir conversa'));
  }
}

/** Distribui a fila (conversas abertas sem atendente), da mais antiga para a mais nova. */
export async function drainQueue(instanceId: string, max = 200): Promise<number> {
  const queued = await prisma.chat.findMany({
    where: { instanceId, leadIsTicketOpen: true, leadAssignedAttendantId: '', isGroup: false, locked: false },
    orderBy: { lastMsgTimestamp: 'asc' },
    select: { chatid: true },
    take: max,
  });
  let assigned = 0;
  for (const c of queued) {
    const r = await assignChat(instanceId, c.chatid);
    if (r.outcome === 'queued' || r.outcome === 'busy') break; // ninguém disponível / outra distribuição em curso
    if (r.outcome === 'assigned') assigned++;
  }
  return assigned;
}

/** Tira as conversas abertas de um atendente (removido/desativado) e devolve à fila. */
export async function requeueAgentChats(instanceId: string, userId: string): Promise<number> {
  const r = await prisma.chat.updateMany({
    where: { instanceId, leadAssignedAttendantId: userId, leadIsTicketOpen: true },
    data: { leadAssignedAttendantId: '' },
  });
  return r.count;
}

// Varredura periódica: pausas que venceram (fim do almoço/férias) liberam a fila sozinhas.
let timer: NodeJS.Timeout | undefined;
export function startAgentScheduler(): void {
  const tick = async () => {
    if (!(await acquireLock('agent-scheduler', env.NODE_ID, 55_000))) return;
    const instances = await prisma.instanceAgent.findMany({ where: { active: true }, distinct: ['instanceId'], select: { instanceId: true } });
    for (const { instanceId } of instances) await drainQueue(instanceId, 50);
  };
  timer = setInterval(() => void tick().catch((err: Error) => logger.error({ err: err.message }, 'varredura da fila falhou')), 60_000);
  timer.unref();
}
export function stopAgentScheduler(): void {
  clearInterval(timer);
}
