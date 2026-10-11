import { hmacSha256Hex, safeEqual } from './crypto.js';

/**
 * Comprovante de "desbloqueio" das conversas trancadas.
 * Por quê: trancar uma conversa só protege se abrir exigir a senha de novo — não
 * basta o painel esconder. O dono confirma a senha, recebe este comprovante (15 min,
 * amarrado ao usuário e ao número) e o servidor exige o header X-Unlock-Token para
 * listar/ler conversas trancadas. Atendentes nunca veem conversas trancadas.
 */
export const UNLOCK_TTL_SEC = 15 * 60;

export function signUnlock(secret: string, userId: string, instanceId: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + UNLOCK_TTL_SEC;
  const sig = hmacSha256Hex(secret, `unlock:${userId}:${instanceId}:${exp}`).slice(0, 40);
  return `${exp}.${sig}`;
}

export function verifyUnlock(secret: string, token: unknown, userId: string, instanceId: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (typeof token !== 'string' || !/^\d{10}\.[a-f0-9]{40}$/.test(token)) return false;
  const [expStr, sig] = token.split('.') as [string, string];
  const exp = Number(expStr);
  if (exp < nowSec || exp > nowSec + UNLOCK_TTL_SEC) return false;
  return safeEqual(hmacSha256Hex(secret, `unlock:${userId}:${instanceId}:${exp}`).slice(0, 40), sig);
}
