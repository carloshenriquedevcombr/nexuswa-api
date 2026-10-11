import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { sha256Hex } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';

/**
 * Rate limiting distribuído (contadores no Redis → vale para todas as réplicas).
 * Camadas: global por IP (DoS camada 7), login por IP+e-mail (brute force /
 * credential stuffing) e envio por credencial (abuso/spam que leva a banimento do número).
 */
const store = (prefix: string) =>
  new RedisStore({
    prefix: `nwa:rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });

const common = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde e tente novamente.', error_key: 'rate_limited' },
};

export const globalLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_GLOBAL_PER_MIN,
  store: store('global'),
});

export const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 10,
  store: store('login'),
  // Chave por IP + e-mail: impede tanto 1 IP testando muitas contas quanto
  // uma conta sendo atacada de muitos IPs (o bloqueio de conta cobre o segundo caso).
  keyGenerator: (req: Request) => `${req.ip}:${sha256Hex(String((req.body as { email?: string })?.email ?? '').toLowerCase())}`,
});

/** Renovação de sessão: chave por token (usuários atrás do mesmo NAT não competem entre si). */
export const refreshLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 30,
  store: store('refresh'),
  keyGenerator: (req: Request) => {
    const raw = (req.cookies as Record<string, string> | undefined)?.nwa_rt ?? (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    return raw ? `rt:${sha256Hex(String(raw))}` : `ip:${req.ip}`;
  },
});

export const sendLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_SEND_PER_MIN,
  store: store('send'),
  keyGenerator: (req: Request) => `inst:${req.auth?.instance?.id ?? req.ip}`,
});

export const sensitiveLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 30,
  store: store('sensitive'),
});
