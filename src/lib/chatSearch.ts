/**
 * Busca livre de conversas do painel ("q"): nome, nome salvo, pushName, lead ou número.
 * Por quê não usar só `contains` do Prisma: ele diferencia acentos ("delicias" ≠
 * "Delícias") e o número digitado raramente bate com o JID ("(19) 99911-0000" vs
 * "5519999110000", ou contas antigas sem o 9º dígito). A normalização é feita aqui e a
 * consulta usa parâmetros ($queryRaw com template) — sem concatenação de SQL.
 */
export const ACCENTS_FROM = 'áàâãäåéèêëíìîïóòôõöúùûüçñ';
export const ACCENTS_TO = 'aaaaaaeeeeiiiiooooouuuucn';

export function foldText(s: string): string {
  let out = s.toLowerCase();
  for (let i = 0; i < ACCENTS_FROM.length; i++) out = out.split(ACCENTS_FROM[i]!).join(ACCENTS_TO[i]!);
  return out;
}

/** Escapa curingas do LIKE para o texto do usuário ser literal. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface ChatSearchPatterns {
  text: string; // padrão LIKE para os nomes (já dobrado)
  digits: string[]; // padrões LIKE para o número (com e sem o 9º dígito)
}

export function chatSearchPatterns(q: string): ChatSearchPatterns | null {
  const clean = q.trim().slice(0, 100);
  if (!clean) return null;
  const text = `%${escapeLike(foldText(clean))}%`;
  const d = clean.replace(/\D/g, '');
  const digits = new Set<string>();
  // Só trata como número se a busca for essencialmente numérica (evita "Loja 2" casar com todo número com 2).
  if (d.length >= 3 && d.length >= clean.replace(/[\s()+\-.]/g, '').length - 1) {
    digits.add(d);
    // Sem o 9º dígito: DDD+9+8 (11 dígitos) ou 55+DDD+9+8 (13 dígitos).
    if (d.length === 11 && d[2] === '9') digits.add(d.slice(0, 2) + d.slice(3));
    if (d.length === 13 && d.startsWith('55') && d[4] === '9') digits.add(d.slice(0, 4) + d.slice(5));
    // Com o 9º dígito, caso a busca venha no formato antigo.
    if (d.length === 10) digits.add(`${d.slice(0, 2)}9${d.slice(2)}`);
    if (d.length === 12 && d.startsWith('55')) digits.add(`${d.slice(0, 4)}9${d.slice(4)}`);
  }
  return { text, digits: [...digits].map((x) => `%${x}%`) };
}
