import crypto from 'node:crypto';

/**
 * Votos de enquete chegam CIFRADOS (pollUpdateMessage). Para contar os votos é preciso
 * decifrar com o segredo da enquete (messageSecret da mensagem original).
 *
 * Por quê implementar aqui em vez de depender só do Baileys: com os endereços LID do
 * WhatsApp, o Baileys às vezes tenta decifrar com o JID "errado" (número x LID) e o voto
 * some em silêncio — era o que deixava a enquete com 0 votos. Aqui tentamos todas as
 * combinações conhecidas de criador/votante (número e LID) até uma autenticar.
 * O GCM autentica o conteúdo: combinação errada falha, nunca gera voto falso.
 */

const bin = (s: string) => Buffer.from(s, 'utf8');

export function pollVoteKey(pollEncKey: Buffer, pollMsgId: string, pollCreatorJid: string, voterJid: string): Buffer {
  const sign = Buffer.concat([bin(pollMsgId), bin(pollCreatorJid), bin(voterJid), bin('Poll Vote'), Buffer.from([1])]);
  const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(pollEncKey).digest();
  return crypto.createHmac('sha256', key0).update(sign).digest();
}

/** Decodifica PollVoteMessage { repeated bytes selectedOptions = 1 } (protobuf mínimo). */
export function decodeSelectedOptions(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  const varint = () => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('protobuf truncado');
      const b = buf[i++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 35) throw new Error('varint inválido');
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('protobuf truncado');
      if (field === 1) out.push(buf.subarray(i, i + len));
      i += len;
    } else if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('wire type desconhecido');
  }
  return out;
}

export function decryptPollVote(
  vote: { encPayload: Buffer; encIv: Buffer },
  ctx: { pollEncKey: Buffer; pollMsgId: string; pollCreatorJid: string; voterJid: string },
): Buffer[] {
  const key = pollVoteKey(ctx.pollEncKey, ctx.pollMsgId, ctx.pollCreatorJid, ctx.voterJid);
  const data = vote.encPayload;
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, vote.encIv, { authTagLength: 16 });
  decipher.setAAD(bin(`${ctx.pollMsgId}\u0000${ctx.voterJid}`));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return decodeSelectedOptions(plain);
}

/** Usado nos testes e para conferir o formato: cifra como o WhatsApp cifra. */
export function encryptPollVoteForTest(selected: string[], ctx: { pollEncKey: Buffer; pollMsgId: string; pollCreatorJid: string; voterJid: string }) {
  const hashes = selected.map((s) => crypto.createHash('sha256').update(s).digest());
  const plain = Buffer.concat(hashes.flatMap((h) => [Buffer.from([0x0a, h.length]), h]));
  const key = pollVoteKey(ctx.pollEncKey, ctx.pollMsgId, ctx.pollCreatorJid, ctx.voterJid);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(bin(`${ctx.pollMsgId}\u0000${ctx.voterJid}`));
  const enc = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { encPayload: enc, encIv: iv };
}

const normJid = (j: string) => j.replace(/:\d+(?=@)/, '');

/**
 * Tenta todas as combinações criador × votante. Devolve os NOMES das opções escolhidas
 * (o voto traz só o SHA-256 de cada nome) ou null se nenhuma combinação autenticou.
 */
export function resolvePollVote(
  vote: { encPayload: Buffer; encIv: Buffer },
  pollEncKey: Buffer,
  pollMsgId: string,
  creators: Array<string | null | undefined>,
  voters: Array<string | null | undefined>,
  optionNames: string[],
): string[] | null {
  const uniq = (a: Array<string | null | undefined>) => [...new Set(a.filter((x): x is string => Boolean(x)).map(normJid))];
  const byHash = new Map(optionNames.map((n) => [crypto.createHash('sha256').update(n).digest('hex'), n]));
  for (const creator of uniq(creators)) {
    for (const voter of uniq(voters)) {
      try {
        const hashes = decryptPollVote(vote, { pollEncKey, pollMsgId, pollCreatorJid: creator, voterJid: voter });
        return hashes.map((h) => byHash.get(Buffer.from(h).toString('hex'))).filter((n): n is string => Boolean(n));
      } catch {
        // combinação errada: tenta a próxima
      }
    }
  }
  return null;
}
