import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Conexões Redis.
 * - `redis`: comandos gerais (cache, rate limit, locks, idempotência).
 * - `createRedisConnection()`: conexões dedicadas para BullMQ e pub/sub, que
 *   exigem `maxRetriesPerRequest: null` e não podem compartilhar a conexão de comandos.
 */
export function createRedisConnection(name: string): Redis {
  const conn = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `nexuswa:${name}`,
    lazyConnect: false,
  });
  conn.on('error', (err: Error) => logger.error({ err: err.message, conn: name }, 'redis error'));
  return conn;
}

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectionName: 'nexuswa:cmd',
});
redis.on('error', (err: Error) => logger.error({ err: err.message }, 'redis error'));

/** Chaves com namespace fixo — evita colisão com outros sistemas que usem o mesmo Redis. */
export const rk = (...parts: string[]) => `nwa:${parts.join(':')}`;
