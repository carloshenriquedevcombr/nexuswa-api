import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { InvalidNumberError } from '../lib/jid.js';
import { logger, scrubUrl } from '../lib/logger.js';
import { httpDuration } from '../lib/metrics.js';
import { SsrfError } from '../lib/ssrf.js';

/** Correlation ID: aceita o do proxy (se bem formado) ou gera um; volta no header. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

/** Log de acesso + métrica de latência. Nunca registra corpo, headers sensíveis ou query. */
export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const sec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    httpDuration.labels(req.method, `${req.baseUrl}${route}`, String(res.statusCode)).observe(sec);
    if (req.path === '/health') return;
    logger.info(
      {
        reqId: req.id,
        method: req.method,
        url: scrubUrl(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(sec * 1000),
        ip: req.ip,
        instance: req.auth?.instance?.id,
        user: req.auth?.user?.id,
      },
      'http',
    );
  });
  next();
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Rota não encontrada', error_key: 'not_found' });
}

/**
 * Handler global de erros.
 * Regra: somente HttpError/erros de validação expõem mensagem. Qualquer outro erro
 * vira 500 genérico com o requestId para suporte — sem stack, sem SQL, sem caminho de arquivo.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, error_key: err.errorKey, details: err.details, requestId: req.id });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Payload inválido', error_key: 'bad_request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return;
  }
  if (err instanceof SsrfError || err instanceof InvalidNumberError) {
    res.status(400).json({ error: err.message, error_key: 'bad_request', requestId: req.id });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  // Erros 4xx do `send` (res.sendFile): arquivo inexistente vira 404, não 500.
  if (e?.status === 404) {
    res.status(404).json({ error: 'Arquivo não encontrado', error_key: 'not_found', requestId: req.id });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload grande demais', error_key: 'payload_too_large' });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON inválido', error_key: 'bad_json' });
    return;
  }
  logger.error({ reqId: req.id, err: err instanceof Error ? { message: err.message, stack: isProd ? undefined : err.stack } : err }, 'erro não tratado');
  res.status(500).json({ error: 'Erro interno', error_key: 'internal', requestId: req.id });
}
