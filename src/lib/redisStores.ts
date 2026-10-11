import type { BreakerStore } from './circuitBreaker.js';
import { redis, rk } from './redis.js';

export class RedisBreakerStore implements BreakerStore {
  async get(key: string) {
    const v = await redis.get(rk('cb', key));
    return v ? (JSON.parse(v) as { failures: number; openedUntil: number }) : null;
  }
  async set(key: string, value: { failures: number; openedUntil: number }, ttlSec: number) {
    await redis.set(rk('cb', key), JSON.stringify(value), 'EX', ttlSec);
  }
  async del(key: string) {
    await redis.del(rk('cb', key));
  }
}

/**
 * Lock distribuído simples (SET NX PX + liberação atômica via Lua).
 * Uso: garantir que apenas UM nó mantenha o socket de uma sessão WhatsApp —
 * duas conexões simultâneas do mesmo número causam conflito e risco de banimento.
 */
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export async function acquireLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const ok = await redis.set(rk('lock', name), owner, 'PX', ttlMs, 'NX');
  if (ok === 'OK') return true;
  // Reentrante para o mesmo dono (ex.: reconexão no mesmo nó).
  const current = await redis.get(rk('lock', name));
  if (current === owner) {
    await redis.pexpire(rk('lock', name), ttlMs);
    return true;
  }
  return false;
}

export async function extendLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.eval(EXTEND_LUA, 1, rk('lock', name), owner, String(ttlMs))) === 1;
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, rk('lock', name), owner);
}

export async function lockOwner(name: string): Promise<string | null> {
  return redis.get(rk('lock', name));
}
