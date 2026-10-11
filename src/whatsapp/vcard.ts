/**
 * Geração de vCard 3.0 com escape de campos.
 * Por quê: sem escape, um nome contendo "\nTEL:..." injetaria linhas no cartão
 * (vCard injection), exibindo um telefone diferente do pretendido.
 */
export function vcardEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ').replace(/[;,]/g, (m) => `\\${m}`).slice(0, 300);
}

export function buildVCard(input: { fullName: string; phoneNumber: string; organization?: string; email?: string; url?: string }): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardEscape(input.fullName)}`];
  if (input.organization) lines.push(`ORG:${vcardEscape(input.organization)};`);
  for (const raw of input.phoneNumber.split(',')) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) lines.push(`TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`);
  }
  if (input.email) lines.push(`EMAIL:${vcardEscape(input.email)}`);
  if (input.url) lines.push(`URL:${vcardEscape(input.url)}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}
