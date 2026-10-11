import './lib/consoleGuard.js'; // precisa ser o primeiro import: silencia logs com chaves da libsignal
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { closeAsyncQueues, ensureAsyncWorker } from './services/asyncQueue.js';
import { startAgentScheduler, stopAgentScheduler } from './services/agentRouter.js';
import { startCampaignWorker, stopCampaignWorker } from './services/campaignWorker.js';
import { startMaintenance, stopMaintenance } from './services/maintenance.js';
import { startSseHub } from './services/sse.js';
import { startWebhookDispatcher, stopWebhookDispatcher } from './services/webhookDispatcher.js';
import { SessionManager } from './whatsapp/SessionManager.js';

// BigInt (timestamps em ms no Postgres) não é serializável por padrão no JSON.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

async function main(): Promise<void> {
  await prisma.$connect();
  await redis.ping();

  // link-preview-js faria o Baileys buscar URLs do texto sem proteção SSRF.
  // Não é dependência do projeto; se alguém instalar, avisamos alto.
  try {
    await import('link-preview-js' as string);
    logger.warn('link-preview-js instalado: remova-o (o NexusWA gera previews com proteção SSRF)');
  } catch {
    /* ausente — esperado */
  }

  startWebhookDispatcher();
  startAgentScheduler();
  startSseHub();
  SessionManager.start();

  const app = buildApp();
  const server = app.listen(env.PORT, env.HOST, () => logger.info({ port: env.PORT }, 'NexusWA API no ar'));
  // Timeouts defensivos contra slowloris / conexões penduradas.
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;

  await SessionManager.restore();
  // Filas async com mensagens pendentes voltam a ser processadas após restart.
  const pending = await prisma.message.findMany({ where: { status: 'Queued' }, distinct: ['instanceId'], select: { instanceId: true } });
  pending.forEach((p) => ensureAsyncWorker(p.instanceId));
  await startCampaignWorker();
  startMaintenance();

  let closing = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'encerrando com segurança');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close();
    stopCampaignWorker();
    stopMaintenance();
    await SessionManager.shutdown(); // sessões preservadas para o próximo boot
    await closeAsyncQueues();
    stopAgentScheduler();
    await stopWebhookDispatcher();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'falha ao iniciar');
  process.exit(1);
});
