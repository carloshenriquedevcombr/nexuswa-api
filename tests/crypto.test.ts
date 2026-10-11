import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { Cipher, generateToken, safeEqual, sha256Hex, signWebhook, verifyWebhookSignature } from '../src/lib/crypto.js';

const key = crypto.randomBytes(32).toString('base64');

describe('Cipher (AES-256-GCM)', () => {
  it('cifra e decifra', () => {
    const c = new Cipher(key);
    assert.equal(c.decrypt(c.encrypt('segredo', 'ctx'), 'ctx'), 'segredo');
  });
  it('gera IV aleatório (mesmo texto → ciphertexts diferentes)', () => {
    const c = new Cipher(key);
    assert.notEqual(c.encrypt('x'), c.encrypt('x'));
  });
  it('rejeita AAD diferente (valor copiado para outro registro)', () => {
    const c = new Cipher(key);
    const enc = c.encrypt('segredo', 'instancia-A');
    assert.throws(() => c.decrypt(enc, 'instancia-B'));
  });
  it('rejeita tag de autenticação truncada', () => {
    const c = new Cipher(key);
    const parts = c.encrypt('segredo').split('.');
    parts[2] = Buffer.from(parts[2]!, 'base64url').subarray(0, 4).toString('base64url');
    assert.throws(() => c.decrypt(parts.join('.')));
  });
  it('rejeita ciphertext adulterado', () => {
    const c = new Cipher(key);
    const parts = c.encrypt('segredo').split('.');
    parts[3] = Buffer.from('outro-dado').toString('base64url');
    assert.throws(() => c.decrypt(parts.join('.')));
  });
  it('rejeita chave com tamanho errado', () => {
    assert.throws(() => new Cipher(Buffer.alloc(16).toString('base64')));
  });
});

describe('tokens e comparação', () => {
  it('token tem prefixo e 256 bits', () => {
    const t = generateToken('nwa', 32);
    assert.match(t, /^nwa_[A-Za-z0-9_-]{43}$/);
  });
  it('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
  it('sha256Hex determinístico', () => {
    assert.equal(sha256Hex('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});

describe('assinatura de webhook', () => {
  it('valida assinatura correta dentro da tolerância', () => {
    const now = 1_700_000_000;
    const h = signWebhook('s3cr3t', '{"a":1}', now);
    assert.equal(verifyWebhookSignature('s3cr3t', '{"a":1}', h, 300, now + 10), true);
  });
  it('rejeita corpo alterado, segredo errado e replay antigo', () => {
    const now = 1_700_000_000;
    const h = signWebhook('s3cr3t', '{"a":1}', now);
    assert.equal(verifyWebhookSignature('s3cr3t', '{"a":2}', h, 300, now), false);
    assert.equal(verifyWebhookSignature('outro', '{"a":1}', h, 300, now), false);
    assert.equal(verifyWebhookSignature('s3cr3t', '{"a":1}', h, 300, now + 301), false);
  });
});
