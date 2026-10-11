import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { decodeSelectedOptions, encryptPollVoteForTest, resolvePollVote } from '../src/whatsapp/pollCrypto.js';

const secret = crypto.randomBytes(32);
const ctx = { pollEncKey: secret, pollMsgId: '3EB0ABCDEF', pollCreatorJid: '5519988887777@s.whatsapp.net', voterJid: '123456789012345@lid' };
const options = ['Manhã', 'Tarde', 'Noite'];

describe('votos de enquete', () => {
  it('decifra com a combinação certa entre várias (número e LID)', () => {
    const vote = encryptPollVoteForTest(['Tarde'], ctx);
    const r = resolvePollVote(vote, secret, ctx.pollMsgId, ['5519988887777@s.whatsapp.net', '999@lid'], ['5511900000000@s.whatsapp.net', '123456789012345:12@lid'], options);
    assert.deepEqual(r, ['Tarde']);
  });
  it('voto com várias opções', () => {
    const vote = encryptPollVoteForTest(['Manhã', 'Noite'], ctx);
    assert.deepEqual(resolvePollVote(vote, secret, ctx.pollMsgId, [ctx.pollCreatorJid], [ctx.voterJid], options), ['Manhã', 'Noite']);
  });
  it('segredo ou JID errado nunca gera voto falso', () => {
    const vote = encryptPollVoteForTest(['Tarde'], ctx);
    assert.equal(resolvePollVote(vote, crypto.randomBytes(32), ctx.pollMsgId, [ctx.pollCreatorJid], [ctx.voterJid], options), null);
    assert.equal(resolvePollVote(vote, secret, ctx.pollMsgId, [ctx.pollCreatorJid], ['1@lid'], options), null);
  });
  it('voto vazio (retirou o voto)', () => {
    const vote = encryptPollVoteForTest([], ctx);
    assert.deepEqual(resolvePollVote(vote, secret, ctx.pollMsgId, [ctx.pollCreatorJid], [ctx.voterJid], options), []);
  });
  it('protobuf truncado é rejeitado', () => assert.throws(() => decodeSelectedOptions(Buffer.from([0x0a, 0x20, 0x01]))));
});
