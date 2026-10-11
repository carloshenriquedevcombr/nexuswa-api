import type { NextFunction, Request, Response } from 'express';
import { JWT_AUD, JWT_ISS, sessionVersion } from '../auth/auth.service.js';
import { JwtError, verifyJwt } from '../auth/jwt.js';
import { env } from '../config/env.js';
import { safeEqual, sha256Hex } from '../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { enforceAgentScope } from './agentScope.js';

export const ACCESS_COOKIE = 'nwa_at';
export const REFRESH_COOKIE = 'nwa_rt';
export const CSRF_COOKIE = 'nwa_csrf';

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Identifica o chamador (não bloqueia). Três credenciais independentes:
 *  - `admintoken`  → escopo de servidor (comparação em tempo constante com o .env)
 *  - `token`       → escopo de UMA instância (buscado pelo hash SHA-256; o banco nunca guarda o token)
 *  - JWT (cookie `nwa_at` ou `Authorization: Bearer`) → usuário humano com papel
 * A autorização efetiva é decidida pelos middlewares `require*` de cada rota.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.auth = { adminToken: false };

  const adminHeader = header(req, 'admintoken');
  if (adminHeader) {
    if (!safeEqual(adminHeader, env.ADMIN_TOKEN)) throw unauthorized('admintoken inválido');
    req.auth.adminToken = true;
  }

  // Token de instância: header. Query string apenas no /sse (EventSource não envia headers).
  let instToken = header(req, 'token');
  if (!instToken && req.path === '/sse' && typeof req.query.token === 'string') instToken = req.query.token;
  if (instToken) {
    if (instToken.length > 200) throw unauthorized();
    const instance = await prisma.instance.findUnique({ where: { tokenHash: sha256Hex(instToken) } });
    if (!instance) throw unauthorized('token inválido');
    req.auth.instance = instance;
    req.auth.instanceVia = 'token';
  }

  const authz = header(req, 'authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;
  const cookieJwt = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  const jwt = bearer ?? cookieJwt;
  if (jwt) {
    try {
      const claims = verifyJwt(jwt, env.JWT_SECRET, { iss: JWT_ISS, aud: JWT_AUD });
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      // Usuário desativado ou senha trocada depois da emissão → token morto.
      if (user && user.isActive && claims.sv >= sessionVersion(user)) {
        req.auth.user = { id: user.id, email: user.email, role: user.role, maxInstances: user.maxInstances };
        req.auth.via = bearer ? 'bearer' : 'cookie';
      } else if (bearer) {
        throw unauthorized('Sessão inválida');
      }
    } catch (err) {
      if (bearer) throw err instanceof JwtError ? unauthorized('Token de acesso inválido ou expirado') : err;
      // Cookie inválido/expirado: segue anônimo; o dashboard chamará /auth/refresh.
    }
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth.user) throw unauthorized('Login necessário');
  next();
}

export function requireRole(role: 'admin') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth.user) throw unauthorized('Login necessário');
    if (req.auth.user.role !== role) throw forbidden();
    next();
  };
}

/** admintoken OU usuário admin (operações de servidor). */
export function requireServerAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth.adminToken || req.auth.user?.role === 'admin') return next();
  throw req.auth.user ? forbidden() : unauthorized('admintoken obrigatório');
}

/** admintoken OU qualquer usuário logado (a regra fina fica na rota, ex.: cota de instâncias). */
export function requireAdminOrUser(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth.user?.role === 'agent') throw forbidden('Atendentes não gerenciam instâncias');
  if (req.auth.adminToken || req.auth.user) return next();
  throw unauthorized();
}

/**
 * Resolve a instância alvo.
 * Proteção IDOR: via usuário, o ID vem de `X-Instance-Id` mas só é aceito se a
 * instância pertencer ao usuário (ou se ele for admin). Via token, o próprio token
 * já identifica a instância — nenhum ID do cliente é considerado.
 */
export async function requireInstance(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.auth.instance) return next();
  const user = req.auth.user;
  if (!user) throw unauthorized('Header token obrigatório');
  // originalUrl: sob app.use('/sse', ...) o req.path vira '/', então não serve para identificar a rota.
  const isSse = req.originalUrl.split('?')[0] === '/sse';
  const id = header(req, 'x-instance-id') ?? (isSse && typeof req.query.instance_id === 'string' ? req.query.instance_id : undefined);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw unauthorized('Informe X-Instance-Id');
  if (user.role === 'agent') {
    // Atendente: precisa estar vinculado e ativo NESTE número, e só acessa rotas liberadas.
    const link = await prisma.instanceAgent.findFirst({ where: { instanceId: id, userId: user.id, active: true }, include: { instance: true } });
    if (!link) throw notFound('Instância não encontrada');
    await enforceAgentScope(req, link.instanceId, user.id);
    req.auth.instance = link.instance;
    req.auth.instanceVia = 'agent';
    req.auth.agent = { userId: user.id };
    return next();
  }
  const instance = await prisma.instance.findFirst({
    where: user.role === 'admin' ? { id } : { id, ownerId: user.id },
  });
  // 404 (e não 403) para não revelar a existência de instâncias de outros tenants.
  if (!instance) throw notFound('Instância não encontrada');
  req.auth.instance = instance;
  req.auth.instanceVia = 'user';
  next();
}

/** Atalho tipado para rotas que já passaram por requireInstance. */
export function inst(req: Request) {
  const i = req.auth.instance;
  if (!i) throw unauthorized();
  return i;
}
