import type { Instance } from '@prisma/client';
import { env } from '../config/env.js';
import { conflict, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { sessionsGauge } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { acquireLock, extendLock, lockOwner, releaseLock } from '../lib/redisStores.js';
import { hasCredentials } from './authState.js';
import { InstanceSession, type BrowserChoice } from './session.js';

const LOCK_TTL = 30_000;

/**
 * Registro das sessões ativas NESTE nó (padrão Registry + Singleton).
 *
 * Escala horizontal: o tráfego HTTP pode ser balanceado entre réplicas, mas cada
 * sessão WhatsApp vive em exatamente um nó — garantido por lock distribuído no Redis
 * renovado a cada 10s. Se o nó morrer, o lock expira em 30s e outro nó pode assumir.
 */
class SessionManagerImpl {
  private sessions = new Map<string, InstanceSession>();
  private renewTimer?: NodeJS.Timeout;

  start(): void {
    this.renewTimer = setInterval(() => void this.renewLocks(), 10_000);
    this.renewTimer.unref();
  }

  private lockName(id: string) {
    return `session:${id}`;
  }

  private async renewLocks(): Promise<void> {
    for (const [id, s] of this.sessions) {
      let ok: boolean;
      try {
        ok = await extendLock(this.lockName(id), env.NODE_ID, LOCK_TTL);
      } catch {
        continue; // falha transitória do Redis: tenta de novo no próximo ciclo (não derruba a sessão)
      }
      if (!ok) {
        // Perdemos o lock (ex.: Redis reiniciou e outro nó assumiu): encerra localmente para não duplicar.
        logger.warn({ instance: id }, 'lock de sessão perdido; encerrando sessão local');
        s.detach();
        this.sessions.delete(id);
      }
    }
    sessionsGauge.reset();
    for (const s of this.sessions.values()) sessionsGauge.inc({ state: s.instance.status });
  }

  get(id: string): InstanceSession | undefined {
    return this.sessions.get(id);
  }

  /** Sessão conectada ou erro HTTP explicativo — usado por todas as rotas de envio/consulta ao WhatsApp. */
  async requireConnected(instance: Instance): Promise<InstanceSession> {
    const s = this.sessions.get(instance.id);
    if (s?.isConnected) return s;
    if (!s) {
      const owner = await lockOwner(this.lockName(instance.id));
      if (owner && owner !== env.NODE_ID) throw conflict('Sessão hospedada em outro nó do cluster');
    }
    throw new HttpError(409, `Instância não conectada (status: ${s?.instance.status ?? instance.status})`, 'instance_not_connected');
  }

  async connect(instance: Instance, opts: { phone?: string; browser?: BrowserChoice } = {}): Promise<InstanceSession> {
    // Sessão existente (inclusive aguardando reconexão) é reaproveitada: criar outra geraria
    // dois sockets para o mesmo número e o WhatsApp derrubaria ambos (connectionReplaced).
    const existing = this.sessions.get(instance.id);
    if (existing) {
      // Pedido de CÓDIGO com uma sessão ainda não pareada (ex.: estava no QR ou com um código
      // vencido): reinicia o socket para gerar um código NOVO. Antes, a sessão antiga era
      // reaproveitada e o painel mostrava o código velho → "solicite um novo código" no celular.
      if (opts.phone && !existing.isConnected && !existing.sock?.authState.creds.registered) {
        await existing.stop(false);
        await new Promise((r) => setTimeout(r, 100)); // deixa a limpeza da sessão antiga (lock) terminar
      } else {
        return existing;
      }
    }
    if (!(await acquireLock(this.lockName(instance.id), env.NODE_ID, LOCK_TTL))) {
      throw conflict('Esta instância já está sendo conectada por outro nó');
    }
    const session: InstanceSession = new InstanceSession(instance, (id) => void this.onFinished(id, session));
    this.sessions.set(instance.id, session);
    try {
      await session.connect(opts);
    } catch (err) {
      this.sessions.delete(instance.id);
      await releaseLock(this.lockName(instance.id), env.NODE_ID);
      throw err;
    }
    return session;
  }

  private async onFinished(id: string, session: InstanceSession): Promise<void> {
    // Só remove se ainda for a MESMA sessão (uma nova pode já ter assumido o lugar).
    if (this.sessions.get(id) !== session) return;
    this.sessions.delete(id);
    await releaseLock(this.lockName(id), env.NODE_ID).catch(() => undefined);
  }

  async disconnect(instance: Instance, logout: boolean): Promise<void> {
    const s = this.sessions.get(instance.id);
    if (s) await s.stop(logout);
    else if (logout) {
      const { clearAuthState } = await import('./authState.js');
      await clearAuthState(instance.id);
      await prisma.instance.update({ where: { id: instance.id }, data: { status: 'disconnected', ownerJid: '', qrcode: '', paircode: '' } });
    }
  }

  /** Reinicia o socket preservando as credenciais (equivalente a /instance/reset). */
  async reset(instance: Instance): Promise<void> {
    const s = this.sessions.get(instance.id);
    if (s) await s.stop(false);
    await this.connect(await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } }));
  }

  /** No boot: reconecta instâncias que estavam conectadas e possuem credenciais válidas. */
  async restore(): Promise<void> {
    const candidates = await prisma.instance.findMany({ where: { status: { in: ['connected', 'connecting'] } } });
    for (const inst of candidates) {
      if (!(await hasCredentials(inst.id))) {
        await prisma.instance.update({ where: { id: inst.id }, data: { status: 'disconnected', qrcode: '', paircode: '' } });
        continue;
      }
      try {
        await this.connect(inst);
        await new Promise((r) => setTimeout(r, 500)); // espaça conexões para não disparar limites do WhatsApp
      } catch (err) {
        logger.warn({ instance: inst.id, err: (err as Error).message }, 'não foi possível restaurar sessão');
      }
    }
    logger.info({ restored: this.sessions.size }, 'sessões restauradas');
  }

  async shutdown(): Promise<void> {
    clearInterval(this.renewTimer);
    // Fecha sockets sem logout: credenciais preservadas para o próximo boot.
    await Promise.allSettled(
      [...this.sessions.values()].map(async (s) => {
        s.detach();
        await releaseLock(this.lockName(s.id), env.NODE_ID);
      }),
    );
    this.sessions.clear();
  }

  counts() {
    const out = { total: this.sessions.size, connected: 0, connecting: 0 };
    for (const s of this.sessions.values()) {
      if (s.instance.status === 'connected') out.connected++;
      else out.connecting++;
    }
    return out;
  }
}

export const SessionManager = new SessionManagerImpl();
