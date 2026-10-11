import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('consoleGuard', () => {
  it('descarta sessões Signal com chave privada e mantém logs normais', async () => {
    const seen: unknown[][] = [];
    const orig = console.info;
    console.info = (...a: unknown[]) => void seen.push(a);
    await import('../src/lib/consoleGuard.js');
    console.info('Closing session:', { _chains: {}, currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('x') } } });
    console.info({ indexInfo: {}, privKey: 'x' });
    console.info('servidor pronto');
    console.info = orig;
    assert.deepEqual(seen, [['servidor pronto']]);
  });
});
