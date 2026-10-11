import type { Instance } from '@prisma/client';
import { generateToken, sha256Hex } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { removeInstanceQueue } from './asyncQueue.js';
import { invalidateWebhookCache } from './webhookDispatcher.js';

/** Token de instância: 256 bits de entropia, prefixo "nwa_" (detectável por secret scanners). */
export function newInstanceToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = generateToken('nwa', 32);
  return { token, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 10) };
}

export async function createInstance(input: { name: string; systemName?: string; adminField01?: string; adminField02?: string; ownerId?: string | null }) {
  const t = newInstanceToken();
  const instance = await prisma.instance.create({
    data: {
      name: input.name,
      systemName: input.systemName ?? '',
      adminField01: input.adminField01 ?? '',
      adminField02: input.adminField02 ?? '',
      ownerId: input.ownerId ?? null,
      tokenHash: t.tokenHash,
      tokenPrefix: t.tokenPrefix,
    },
  });
  return { instance, token: t.token };
}

/**
 * Cota por cliente, verificada DENTRO de uma transação serializável — sem isso,
 * duas requisições simultâneas poderiam ambas ver "0 de 1" e criar 2 instâncias.
 */
export async function createInstanceWithQuota(userId: string, maxInstances: number, input: { name: string; systemName?: string }) {
  const t = newInstanceToken();
  const instance = await prisma.$transaction(
    async (tx) => {
      const count = await tx.instance.count({ where: { ownerId: userId } });
      if (count >= maxInstances) throw forbidden(`Limite de ${maxInstances} instância(s) atingido para sua conta`);
      return tx.instance.create({
        data: { name: input.name, systemName: input.systemName ?? '', ownerId: userId, tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix },
      });
    },
    { isolationLevel: 'Serializable' },
  );
  return { instance, token: t.token };
}

export async function rotateInstanceToken(instance: Instance) {
  const t = newInstanceToken();
  const updated = await prisma.instance.update({ where: { id: instance.id }, data: { tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix } });
  return { instance: updated, token: t.token };
}

export async function deleteInstance(instance: Instance): Promise<void> {
  await SessionManager.disconnect(instance, true).catch(() => undefined);
  await removeInstanceQueue(instance.id);
  await prisma.instance.delete({ where: { id: instance.id } }); // cascade remove dados relacionados
  invalidateWebhookCache(instance.id);
}
