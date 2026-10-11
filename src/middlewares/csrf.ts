import type { NextFunction, Request, Response } from 'express';
import { safeEqual } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { CSRF_COOKIE } from './auth.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteção CSRF (double-submit cookie).
 * Aplica-se somente quando a credencial veio de COOKIE — é o único caso em que o
 * navegador anexa a credencial automaticamente. Chamadas com header `token`,
 * `admintoken` ou `Authorization: Bearer` não são forjáveis por outro site.
 * Somado a SameSite=Strict nos cookies, forma defesa em profundidade.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method)) return next();
  // /auth/refresh e /auth/logout usam o cookie de refresh: também precisam do token CSRF.
  const refreshViaCookie = (req.path === '/auth/refresh' || req.path === '/auth/logout') && Boolean(req.cookies?.nwa_rt);
  const cookieAuth = req.auth.via === 'cookie' || refreshViaCookie;
  if (!cookieAuth) return next();
  const cookie = (req.cookies as Record<string, string>)[CSRF_COOKIE];
  const sent = req.headers['x-csrf-token'];
  if (!cookie || typeof sent !== 'string' || !safeEqual(cookie, sent)) {
    throw forbidden('Token CSRF ausente ou inválido');
  }
  next();
}
