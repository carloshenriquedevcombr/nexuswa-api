import crypto from 'node:crypto';

/**
 * JWT HS256 mínimo e estrito para o access token (vida curta).
 * Por quê implementar aqui: o escopo é pequeno e fechado (um único algoritmo), o que
 * elimina por construção as falhas clássicas de bibliotecas genéricas:
 *  - `alg: none` e confusão de algoritmo → o header é comparado byte a byte com o esperado;
 *  - assinatura comparada em tempo constante;
 *  - `exp`, `iat`, `iss`, `aud` e `typ` obrigatórios.
 */

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export interface AccessClaims {
  sub: string; // userId
  role: 'admin' | 'client' | 'agent';
  sv: number; // "session version": invalida tokens emitidos antes de troca de senha
  typ: 'access';
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export class JwtError extends Error {}

export function signJwt(claims: Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'typ'>, secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const payload: AccessClaims = {
    ...claims,
    typ: 'access',
    iat: nowSec,
    exp: nowSec + ttlSec,
    jti: crypto.randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${HEADER}.${body}`).digest('base64url');
  return `${HEADER}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string, expected: { iss: string; aud: string }, nowSec = Math.floor(Date.now() / 1000)): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('formato inválido');
  const [h, b, s] = parts as [string, string, string];
  if (h !== HEADER) throw new JwtError('header não suportado');
  const expectedSig = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expectedSig.length || !crypto.timingSafeEqual(given, expectedSig)) {
    throw new JwtError('assinatura inválida');
  }
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    throw new JwtError('payload inválido');
  }
  if (claims.typ !== 'access') throw new JwtError('tipo inválido');
  if (claims.iss !== expected.iss || claims.aud !== expected.aud) throw new JwtError('emissor/audiência inválidos');
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new JwtError('expirado');
  if (typeof claims.iat !== 'number' || claims.iat > nowSec + 60) throw new JwtError('iat no futuro');
  if (claims.role !== 'admin' && claims.role !== 'client' && claims.role !== 'agent') throw new JwtError('papel inválido');
  return claims;
}
