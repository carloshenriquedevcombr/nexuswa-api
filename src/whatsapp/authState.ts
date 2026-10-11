import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { prisma } from '../lib/prisma.js';
import { cipher } from '../lib/security.js';

/**
 * Persistência das credenciais Baileys no Postgres, cifradas com AES-256-GCM.
 * Por quê: a pasta `auth_info` em disco é o alvo nº 1 de quem invade o servidor —
 * com ela o atacante assume a conta WhatsApp. No banco, cifrada e com AAD por
 * instância+chave, um dump do banco sem a ENCRYPTION_KEY é inútil, e o container
 * pode ser recriado sem perder a sessão.
 */

const aad = (instanceId: string, key: string) => `auth:${instanceId}:${key}`;

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}
function deserialize<T>(raw: string): T {
  return JSON.parse(raw, BufferJSON.reviver) as T;
}

async function readKey<T>(instanceId: string, key: string): Promise<T | null> {
  const row = await prisma.authState.findUnique({ where: { instanceId_key: { instanceId, key } } });
  if (!row) return null;
  return deserialize<T>(cipher.decrypt(row.value, aad(instanceId, key)));
}

export async function usePostgresAuthState(instanceId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const creds: AuthenticationCreds = (await readKey<AuthenticationCreds>(instanceId, 'creds')) ?? initAuthCreds();

  const writeKey = (key: string, value: unknown) => {
    const enc = cipher.encrypt(serialize(value), aad(instanceId, key));
    return prisma.authState.upsert({
      where: { instanceId_key: { instanceId, key } },
      create: { instanceId, key, value: enc },
      update: { value: enc },
    });
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;
        const keys = ids.map((id) => `${type}-${id}`);
        const rows = await prisma.authState.findMany({ where: { instanceId, key: { in: keys } } });
        for (const row of rows) {
          const id = row.key.slice(String(type).length + 1);
          let value = deserialize<unknown>(cipher.decrypt(row.value, aad(instanceId, row.key)));
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: async (data) => {
        const ops: Array<Promise<unknown>> = [];
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[type] ?? {};
          for (const id of Object.keys(entries)) {
            const key = `${type}-${id}`;
            const value = (entries as Record<string, unknown>)[id];
            ops.push(value ? writeKey(key, value) : prisma.authState.deleteMany({ where: { instanceId, key } }));
          }
        }
        // Transação: um conjunto de chaves Signal parcialmente gravado corrompe a sessão.
        if (ops.length) await prisma.$transaction(ops as never);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await writeKey('creds', state.creds);
    },
  };
}

export async function clearAuthState(instanceId: string): Promise<void> {
  await prisma.authState.deleteMany({ where: { instanceId } });
}

export async function hasCredentials(instanceId: string): Promise<boolean> {
  const creds = await readKey<AuthenticationCreds>(instanceId, 'creds');
  return Boolean(creds?.registered || creds?.me?.id);
}
