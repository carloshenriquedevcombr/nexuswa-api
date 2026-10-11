import argon2 from 'argon2';

/**
 * Hash de senha com Argon2id (vencedor da Password Hashing Competition,
 * recomendado pela OWASP). O salt é aleatório por hash e fica embutido na string.
 * Parâmetros acima do mínimo OWASP (m=19MiB, t=2): m=64MiB, t=3, p=1.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const PASSWORD_MIN = 12;

export function validatePasswordPolicy(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres`;
  if (password.length > 256) return 'Senha longa demais';
  if (password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) return 'A senha não pode conter o seu e-mail';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'Use ao menos 3 destes: minúsculas, maiúsculas, números, símbolos';
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Hash fixo usado quando o usuário não existe — iguala o tempo de resposta (anti-enumeração). */
let dummyHash: string | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  const hash = dummyHash ?? (dummyHash = await argon2.hash('nexuswa-dummy-password-for-timing', OPTIONS));
  await verifyPassword(hash, password);
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}
