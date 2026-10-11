import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { registry } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { verifyFile } from '../lib/signedUrl.js';
import { parse } from '../lib/validate.js';
import { FILES_SECRET } from '../services/media.js';

export const systemRouter = Router();

/** Liveness: o processo responde. Não toca dependências (evita restart em cascata). */
systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness: Postgres e Redis respondem — usado pelo healthcheck do Docker. */
systemRouter.get('/ready', async (_req, res) => {
  const [db, cache] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
  const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', database: db.status === 'fulfilled', redis: cache.status === 'fulfilled' });
});

/** Métricas Prometheus — protegidas por token próprio (nunca públicas). */
systemRouter.get('/metrics', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (!env.METRICS_TOKEN || !safeEqual(auth, `Bearer ${env.METRICS_TOKEN}`)) throw unauthorized();
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

/** Download de mídia por URL assinada e com expiração. */
systemRouter.get('/files/:name', async (req, res) => {
  const name = String(req.params.name);
  // Nome gerado por storeFile (randomId base64url + extensão): qualquer outra coisa nem chega ao disco.
  if (!/^[A-Za-z0-9_-]{16,64}\.[a-z0-9]{1,8}$/.test(name)) throw notFound('Arquivo não encontrado ou link expirado');
  const q = parse(z.object({ e: z.coerce.number().int(), s: z.string().regex(/^[a-f0-9]{32}$/) }), req.query);
  if (!verifyFile(FILES_SECRET, name, q.e, q.s)) throw notFound('Arquivo não encontrado ou link expirado');
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Content-Disposition: attachment + nosniff: um HTML/SVG malicioso nunca é renderizado no domínio da API.
  // Arquivo ausente: o Express repassa o erro 404 do `send` ao tratador global (responde 404).
  res.sendFile(name, { root: path.resolve(env.MEDIA_DIR), dotfiles: 'deny', maxAge: '1h' });
});
