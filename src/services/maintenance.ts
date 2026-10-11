import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { acquireLock } from '../lib/redisStores.js';
import { cleanupFiles } from './media.js';

/**
 * Rotinas periódicas: retenção de mensagens (LGPD — minimização de dados),
 * limpeza de arquivos expirados, refresh tokens vencidos e auditoria antiga.
 * Lock distribuído: só uma réplica executa por janela.
 */
let timer: NodeJS.Timeout | undefined;

async function run(): Promise<void> {
  if (!(await acquireLock('maintenance', env.NODE_ID, 55 * 60_000))) return;
  const cutoff = new Date(Date.now() - env.MESSAGE_RETENTION_DAYS * 86400_000);
  const [msgs, tokens, audits, files] = await Promise.all([
    prisma.message.deleteMany({ where: { createdAt: { lt: cutoff }, status: { notIn: ['Queued'] } } }),
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 365 * 86400_000) } } }),
    cleanupFiles(),
  ]);
  logger.info({ messages: msgs.count, refreshTokens: tokens.count, audits: audits.count, files }, 'manutenção concluída');
}

export function startMaintenance(): void {
  const exec = () => void run().catch((err) => logger.error({ err: (err as Error).message }, 'manutenção falhou'));
  setTimeout(exec, 60_000).unref();
  timer = setInterval(exec, 60 * 60_000);
  timer.unref();
}

export function stopMaintenance(): void {
  clearInterval(timer);
}
