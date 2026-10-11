import { hmacSha256Hex, safeEqual } from './crypto.js';

/**
 * URLs de arquivo assinadas e com expiração.
 * Por quê: mídias baixadas ficam acessíveis por link (como o fileURL da uazapi), mas
 * o link não pode ser adivinhável nem eterno. O nome é aleatório e a assinatura
 * HMAC cobre nome + expiração, então alterar qualquer um invalida o link.
 */
export function signFile(secret: string, fileName: string, expiresAtSec: number): string {
  const sig = hmacSha256Hex(secret, `file:${fileName}:${expiresAtSec}`).slice(0, 32);
  return `${encodeURIComponent(fileName)}?e=${expiresAtSec}&s=${sig}`;
}

export function verifyFile(
  secret: string,
  fileName: string,
  expiresAtSec: number,
  sig: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!/^[A-Za-z0-9_-]{16,64}\.[a-z0-9]{1,5}$/.test(fileName)) return false; // bloqueia path traversal
  if (!Number.isFinite(expiresAtSec) || expiresAtSec < nowSec) return false;
  const expected = hmacSha256Hex(secret, `file:${fileName}:${expiresAtSec}`).slice(0, 32);
  return safeEqual(expected, sig);
}
