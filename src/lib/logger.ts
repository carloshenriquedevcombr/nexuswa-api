import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Logger estruturado (JSON) com redação de segredos.
 * Por quê: logs vão para agregadores/terminais compartilhados; tokens, senhas e a
 * query do SSE (que carrega token) jamais podem aparecer em texto claro.
 */
export const REDACT_PATHS = [
  'req.headers.token',
  'req.headers.admintoken',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.admintoken',
  '*.openai_apikey',
  '*.proxy_url',
  '*.secret',
  '*.otp',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'nexuswa-api', node: env.NODE_ID },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Remove query strings de URLs antes de logar (SSE usa ?token=). */
export function scrubUrl(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?[REDACTED]`;
}
