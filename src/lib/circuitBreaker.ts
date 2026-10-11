/**
 * Circuit breaker por destino.
 * Por quê: um webhook lento ou fora do ar ocupa workers e atrasa a fila de todas as
 * instâncias (a própria doc da uazapi alerta sobre isso). Após N falhas seguidas o
 * circuito "abre" e as entregas para aquele destino são adiadas sem tentar a rede,
 * até o período de resfriamento passar (estado half-open: uma tentativa de teste).
 */

export interface BreakerStore {
  get(key: string): Promise<{ failures: number; openedUntil: number } | null>;
  set(key: string, value: { failures: number; openedUntil: number }, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryBreakerStore implements BreakerStore {
  private m = new Map<string, { failures: number; openedUntil: number }>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: { failures: number; openedUntil: number }) {
    this.m.set(k, v);
  }
  async del(k: string) {
    this.m.delete(k);
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export class CircuitBreaker {
  constructor(
    private readonly store: BreakerStore,
    private readonly opts: BreakerOptions = { failureThreshold: 5, cooldownMs: 60_000 },
    private readonly now: () => number = Date.now,
  ) {}

  /** Retorna ms restantes de circuito aberto (0 = pode tentar). */
  async blockedFor(key: string): Promise<number> {
    const s = await this.store.get(key);
    if (!s) return 0;
    return Math.max(0, s.openedUntil - this.now());
  }

  async success(key: string): Promise<void> {
    await this.store.del(key);
  }

  async failure(key: string): Promise<{ opened: boolean }> {
    const s = (await this.store.get(key)) ?? { failures: 0, openedUntil: 0 };
    s.failures += 1;
    let opened = false;
    if (s.failures >= this.opts.failureThreshold) {
      s.openedUntil = this.now() + this.opts.cooldownMs;
      opened = true;
    }
    await this.store.set(key, s, Math.ceil((this.opts.cooldownMs * 4) / 1000));
    return { opened };
  }
}
