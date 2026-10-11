import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatSearchPatterns, foldText } from '../src/lib/chatSearch.js';
import { availabilityLabel, inBreak, isAvailable, pickAgent } from '../src/services/agentRules.js';

const TZ = 'America/Sao_Paulo';
// 15:30 UTC = 12:30 em São Paulo (UTC-3)
const lunch = new Date('2026-09-29T15:30:00Z');
const afternoon = new Date('2026-09-29T18:00:00Z'); // 15:00 SP

const base = { active: true, status: 'available', pausedUntil: null as Date | null, breakStart: '', breakEnd: '', pauseReason: '' };
const agent = (id: string, extra: Partial<typeof base> & { lastAssignedAt?: Date | null } = {}) => ({
  id: `link-${id}`,
  userId: id,
  createdAt: new Date('2026-01-01'),
  lastAssignedAt: null as Date | null,
  ...base,
  ...extra,
});

describe('pausas dos atendentes', () => {
  it('almoço 12:00-13:00 no fuso local', () => {
    assert.equal(inBreak('12:00', '13:00', lunch, TZ), true);
    assert.equal(inBreak('12:00', '13:00', afternoon, TZ), false);
  });
  it('intervalo que passa da meia-noite', () => assert.equal(inBreak('22:00', '06:00', new Date('2026-09-30T05:00:00Z'), TZ), true));
  it('horário inválido ou vazio não bloqueia', () => {
    assert.equal(inBreak('', '', lunch, TZ), false);
    assert.equal(inBreak('25:00', '13:00', lunch, TZ), false);
  });
  it('pausa com data de volta vencida conta como disponível', () => {
    assert.equal(isAvailable({ ...base, status: 'paused', pausedUntil: new Date('2026-09-01') }, afternoon), true);
    assert.equal(isAvailable({ ...base, status: 'paused', pausedUntil: new Date('2026-12-01') }, afternoon), false);
    assert.equal(isAvailable({ ...base, status: 'paused', pausedUntil: null }, afternoon), false);
  });
  it('desativado nunca recebe', () => assert.equal(isAvailable({ ...base, active: false }, afternoon), false));
  it('rótulo para o painel', () => assert.equal(availabilityLabel({ ...base, status: 'paused', pauseReason: 'ferias' }, afternoon), 'ferias'));
});

describe('rodízio', () => {
  it('quem recebeu há mais tempo recebe o próximo', () => {
    const a = agent('a', { lastAssignedAt: new Date('2026-09-29T10:00:00Z') } as never);
    const b = agent('b', { lastAssignedAt: new Date('2026-09-29T09:00:00Z') } as never);
    assert.equal(pickAgent([a, b], undefined, afternoon)?.userId, 'b');
  });
  it('cliente que volta cai no mesmo atendente se ele estiver disponível', () => {
    const a = agent('a', { lastAssignedAt: new Date() } as never);
    const b = agent('b');
    assert.equal(pickAgent([a, b], 'a', afternoon)?.userId, 'a');
  });
  it('pula quem está no almoço ou de férias', () => {
    const a = agent('a', { breakStart: '12:00', breakEnd: '13:00' });
    const b = agent('b', { status: 'paused', pauseReason: 'ferias' });
    const c = agent('c', { lastAssignedAt: new Date() } as never);
    assert.equal(pickAgent([a, b, c], 'a', lunch)?.userId, 'c');
  });
  it('ninguém disponível → fila', () => assert.equal(pickAgent([agent('a', { active: false })], undefined, afternoon), undefined));
});

describe('busca de conversas', () => {
  it('ignora acentos', () => assert.equal(foldText('Delícias Ção'), 'delicias cao'));
  it('número formatado vira dígitos, com e sem o 9', () => {
    const p = chatSearchPatterns('(19) 99911-0000')!;
    assert.deepEqual(p.digits, ['%19999110000%', '%1999110000%']);
  });
  it('texto com número não vira busca numérica', () => assert.deepEqual(chatSearchPatterns('Loja 2')!.digits, []));
  it('escapa curingas do LIKE', () => assert.equal(chatSearchPatterns('50%_off')!.text, '%50\\%\\_off%'));
});
