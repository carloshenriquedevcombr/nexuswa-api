import type { InstanceAgent } from '@prisma/client';

/**
 * Regras puras de disponibilidade e rodízio dos atendentes (sem banco, testáveis).
 * O fuso vem de APP_TIMEZONE (padrão America/Sao_Paulo): o servidor roda em UTC, mas
 * "almoço 12:00-13:00" é no horário local da equipe.
 */
export type Availability = Pick<InstanceAgent, 'active' | 'status' | 'pausedUntil' | 'breakStart' | 'breakEnd'>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutos desde a meia-noite no fuso configurado (o servidor roda em UTC). */
export function minutesInTz(now: Date, tz = process.env.APP_TIMEZONE || 'America/Sao_Paulo'): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function inBreak(start: string, end: string, now: Date, tz?: string): boolean {
  const s = HHMM.exec(start);
  const e = HHMM.exec(end);
  if (!s || !e) return false;
  const a = Number(s[1]) * 60 + Number(s[2]);
  const b = Number(e[1]) * 60 + Number(e[2]);
  if (a === b) return false;
  const m = minutesInTz(now, tz);
  return a < b ? m >= a && m < b : m >= a || m < b; // intervalo que passa da meia-noite
}

export function isAvailable(a: Availability, now = new Date(), tz?: string): boolean {
  if (!a.active) return false;
  if (a.status === 'paused' && !(a.pausedUntil && a.pausedUntil <= now)) return false;
  return !inBreak(a.breakStart, a.breakEnd, now, tz);
}

/** Estado legível para o painel. */
export function availabilityLabel(a: Availability & { pauseReason: string }, now = new Date()): string {
  if (!a.active) return 'desativado';
  if (a.status === 'paused' && !(a.pausedUntil && a.pausedUntil <= now)) return a.pauseReason || 'pausa';
  if (inBreak(a.breakStart, a.breakEnd, now)) return 'almoco';
  return 'disponivel';
}

export function pickAgent<T extends Availability & { id: string; userId: string; lastAssignedAt: Date | null; createdAt: Date }>(
  agents: T[],
  preferredUserId?: string,
  now = new Date(),
): T | undefined {
  const avail = agents.filter((a) => isAvailable(a, now));
  if (preferredUserId) {
    const same = avail.find((a) => a.userId === preferredUserId);
    if (same) return same;
  }
  return avail.sort((x, y) => (x.lastAssignedAt?.getTime() ?? 0) - (y.lastAssignedAt?.getTime() ?? 0) || x.createdAt.getTime() - y.createdAt.getTime())[0];
}

