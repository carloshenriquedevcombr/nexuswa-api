import type { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export interface AuditEntry {
  actorType: 'user' | 'admintoken' | 'instance' | 'system' | 'anonymous';
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Trilha de auditoria de ações sensíveis (login, criação/remoção de instância,
 * rotação de token, mudança de papel...). Falha ao auditar nunca derruba a operação
 * de negócio, mas é logada como erro para ser investigada.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? '',
        action: entry.action,
        targetType: entry.targetType ?? '',
        targetId: entry.targetId ?? '',
        ip: entry.ip ?? '',
        requestId: entry.requestId ?? '',
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, action: entry.action }, 'falha ao gravar auditoria');
  }
}
