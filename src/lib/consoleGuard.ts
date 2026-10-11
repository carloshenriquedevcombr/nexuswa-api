/**
 * A biblioteca de criptografia do WhatsApp (libsignal, usada pelo Baileys) imprime com
 * console.* o objeto inteiro da sessão ao abrir/fechar sessões — incluindo CHAVES
 * PRIVADAS (privKey, rootKey, chainKey). Isso iria para o `docker logs` e para qualquer
 * coletor de logs. Aqui essas mensagens são descartadas antes de chegar ao stdout.
 * Importado como PRIMEIRO módulo do servidor, antes do Baileys ser carregado.
 */
const NOISY = /^(Closing session|Opening session|Closing open session|Removing old closed session|Migrating session|Session already|Decrypted message with closed session|Failed to decrypt message with any known session|Session error)/i;

function looksSecret(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first === 'string' && NOISY.test(first)) return true;
  // Salvaguarda: qualquer objeto com cara de sessão Signal também é descartado.
  return args.some((a) => a !== null && typeof a === 'object' && ('_chains' in (a as object) || 'currentRatchet' in (a as object) || 'privKey' in (a as object)));
}

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (looksSecret(args)) return;
    original(...args);
  };
}

export {};
