/**
 * Normalização de destinos do WhatsApp.
 * Regra de negócio (uazapi): `number` aceita número internacional, JID de contato,
 * @lid, grupo (@g.us) e canal (@newsletter). Sufixos nunca são removidos.
 */

export class InvalidNumberError extends Error {
  constructor(input: string) {
    super(`Destino inválido: "${input.slice(0, 40)}"`);
    this.name = 'InvalidNumberError';
  }
}

const SUFFIXES = ['@s.whatsapp.net', '@g.us', '@lid', '@newsletter', '@broadcast', '@c.us'];

export function toJid(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new InvalidNumberError(raw);
  if (raw === 'status@broadcast') return raw;
  const suffix = SUFFIXES.find((s) => raw.endsWith(s));
  if (suffix) {
    const user = raw.slice(0, -suffix.length);
    // Parte antes do @ só pode conter dígitos, hífen (grupos antigos) e ":" (device).
    if (!/^[0-9][0-9:-]{2,40}$/.test(user)) throw new InvalidNumberError(raw);
    return suffix === '@c.us' ? `${user}@s.whatsapp.net` : raw;
  }
  const digits = raw.replace(/[\s()+.-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) throw new InvalidNumberError(raw);
  return `${digits}@s.whatsapp.net`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function isNewsletterJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}

/** Remove o sufixo de device (":12") para comparar identidades. */
export function bareJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

export function phoneFromJid(jid: string): string {
  return (jid.split('@')[0] ?? '').split(':')[0] ?? '';
}
