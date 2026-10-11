import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JwtError, signJwt, verifyJwt } from '../src/auth/jwt.js';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/auth/totp.js';

const SECRET = 'x'.repeat(64);
const exp = { iss: 'nexuswa', aud: 'nexuswa-dashboard' };
const claims = { sub: 'u1', role: 'client' as const, sv: 1, ...exp };

describe('JWT HS256', () => {
  it('emite e valida', () => {
    const t = signJwt(claims, SECRET, 60);
    assert.equal(verifyJwt(t, SECRET, exp).sub, 'u1');
  });
  it('rejeita segredo diferente', () => {
    assert.throws(() => verifyJwt(signJwt(claims, SECRET, 60), 'y'.repeat(64), exp), JwtError);
  });
  it('rejeita expirado', () => {
    const t = signJwt(claims, SECRET, 60, 1000);
    assert.throws(() => verifyJwt(t, SECRET, exp, 2000), /expirado/);
  });
  it('rejeita alg:none (ataque clássico)', () => {
    const [, body] = signJwt(claims, SECRET, 60).split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.throws(() => verifyJwt(`${none}.${body}.`, SECRET, exp), JwtError);
  });
  it('rejeita escalação de papel via payload adulterado', () => {
    const [h, , s] = signJwt(claims, SECRET, 60).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin', typ: 'access', iat: 1, exp: 9e9, jti: 'x' })).toString('base64url');
    assert.throws(() => verifyJwt(`${h}.${forged}.${s}`, SECRET, exp), /assinatura/);
  });
  it('rejeita audiência errada', () => {
    assert.throws(() => verifyJwt(signJwt(claims, SECRET, 60), SECRET, { iss: 'nexuswa', aud: 'outro' }), JwtError);
  });
});

describe('TOTP (RFC 6238)', () => {
  it('vetor oficial RFC 6238 (T=59s → 287082)', () => {
    assert.equal(hotp(Buffer.from('12345678901234567890'), 1), '287082');
  });
  it('base32 ida e volta', () => {
    const b = Buffer.from('12345678901234567890');
    assert.deepEqual(base32Decode(base32Encode(b)), b);
  });
  it('verifyTotp aceita janela atual e ±1, rejeita ±2', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 59_000 + 30_000 * 10;
    const code = hotp(Buffer.from('12345678901234567890'), 11);
    assert.equal(verifyTotp(secret, code, now), true);
    assert.equal(verifyTotp(secret, code, now + 30_000), true);
    assert.equal(verifyTotp(secret, code, now + 90_000), false);
    assert.equal(verifyTotp(secret, 'abcdef', now), false);
  });
});
