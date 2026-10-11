import type { NextFunction, Request, Response } from 'express';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict } from '../lib/errors.js';
import { redis, rk } from '../lib/redis.js';

const TTL_SEC = 24 * 3600;
const LOCK_SEC = 120;

/**
 * Idempotência opcional via header `Idempotency-Key` (padrão IETF draft).
 * Por quê: a doc da uazapi alerta que um timeout deixa o envio incerto e que retry
 * pode duplicar a mensagem. Com a chave, o cliente pode repetir com segurança:
 *  - 1ª chamada: executa e guarda a resposta por 24h;
 *  - repetição com o mesmo corpo: devolve a resposta guardada (sem reenviar);
 *  - repetição enquanto a 1ª ainda roda: 409;
 *  - mesma chave com corpo diferente: 422 (uso incorreto).
 */
export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key) return next();
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw badRequest('Idempotency-Key inválida (8-128 caracteres alfanuméricos)');

  const scope = req.auth.instance?.id ?? req.auth.user?.id ?? 'admin';
  const redisKey = rk('idem', scope, sha256Hex(`${req.method}:${req.path}:${key}`));
  const bodyHash = sha256Hex(JSON.stringify(req.body ?? {}));

  const acquired = await redis.set(redisKey, JSON.stringify({ state: 'running', bodyHash }), 'EX', LOCK_SEC, 'NX');
  if (acquired !== 'OK') {
    const saved = JSON.parse((await redis.get(redisKey)) ?? '{}') as { state?: string; bodyHash?: string; status?: number; body?: unknown };
    if (saved.bodyHash && saved.bodyHash !== bodyHash) {
      res.status(422).json({ error: 'Idempotency-Key já usada com outro payload', error_key: 'idempotency_mismatch' });
      return;
    }
    if (saved.state === 'done') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(saved.status ?? 200).json(saved.body);
      return;
    }
    throw conflict('Requisição com esta Idempotency-Key ainda em processamento');
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const status = res.statusCode;
    // Só respostas bem-sucedidas ou erros de cliente definitivos são memorizados;
    // 5xx libera a chave para permitir nova tentativa.
    const op = status >= 500 ? redis.del(redisKey) : redis.set(redisKey, JSON.stringify({ state: 'done', bodyHash, status, body }), 'EX', TTL_SEC);
    op.catch(() => undefined);
    return originalJson(body);
  };
  next();
}
