import { env } from '../config/env.js';
import { Cipher } from './crypto.js';

/** Instância única do cifrador com a chave do ambiente. */
export const cipher = new Cipher(env.ENCRYPTION_KEY);

/** Helpers de cifragem de campos com AAD por contexto (ver Cipher). */
export const encField = (value: string, context: string) => cipher.encrypt(value, context);
export const decField = (value: string | null | undefined, context: string): string =>
  value ? cipher.decrypt(value, context) : '';
