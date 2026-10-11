import type { Request } from 'express';
import { env } from '../config/env.js';
import { sha256Hex } from './crypto.js';
import { verifyUnlock } from './unlockToken.js';

export const UNLOCK_SECRET = sha256Hex(`unlock:${env.JWT_SECRET}`);

/**
 * Quem enxerga conversas trancadas: integrações (token/admintoken) sim; atendente
 * nunca; pessoa (dono/admin) só com a senha confirmada há menos de 15 min.
 */
export function canSeeLocked(req: Request, instanceId: string): boolean {
  if (req.auth.agent) return false;
  if (req.auth.user) return verifyUnlock(UNLOCK_SECRET, req.headers['x-unlock-token'], req.auth.user.id, instanceId);
  return Boolean(req.auth.adminToken || req.auth.instanceVia === 'token');
}
