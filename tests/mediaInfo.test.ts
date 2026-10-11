import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mediaInfo, toBase64 } from '../src/whatsapp/mediaInfo.js';

const thumb = { type: 'Buffer', data: Buffer.from('fakejpeg').toString('base64') };

describe('mediaInfo (bolhas estilo WhatsApp)', () => {
  it('imagem com legenda e miniatura (formato BufferJSON)', () => {
    const r = mediaInfo({ message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg', jpegThumbnail: thumb, mediaKey: 'SEGREDO' } } })!;
    assert.equal(r.kind, 'image');
    assert.equal(r.caption, 'foto');
    assert.ok(r.thumb?.startsWith('data:image/jpeg;base64,'));
    assert.ok(!JSON.stringify(r).includes('SEGREDO'), 'mediaKey nunca pode sair');
  });
  it('áudio de voz, vídeo e documento', () => {
    assert.deepEqual(
      { kind: mediaInfo({ message: { audioMessage: { ptt: true, seconds: 12 } } })!.kind, ptt: mediaInfo({ message: { audioMessage: { ptt: true, seconds: 12 } } })!.ptt },
      { kind: 'audio', ptt: true },
    );
    assert.equal(mediaInfo({ message: { videoMessage: { seconds: 30 } } })!.seconds, 30);
    assert.equal(mediaInfo({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'boleto.pdf', fileLength: { low: 2048, high: 0 } } } } } })!.fileName, 'boleto.pdf');
  });
  it('mensagem com botões (nativeFlow) como a do banco', () => {
    const r = mediaInfo({
      message: {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              header: { imageMessage: { jpegThumbnail: thumb } },
              body: { text: 'Olá, tudo bem?' },
              nativeFlowMessage: { buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Simular em 1 minuto","id":"a"}' }, { name: 'quick_reply', buttonParamsJson: '{"display_text":"Ficar sem o dinheiro"}' }] },
            },
          },
        },
      },
    })!;
    assert.equal(r.kind, 'interactive');
    assert.deepEqual(r.buttons, ['Simular em 1 minuto', 'Ficar sem o dinheiro']);
    assert.ok(r.thumb);
  });
  it('enquete, localização, contato, resposta citada', () => {
    assert.deepEqual(mediaInfo({ message: { pollCreationMessageV3: { name: 'Horário?', options: [{ optionName: 'Manhã' }, { optionName: 'Tarde' }] } } })!.options, ['Manhã', 'Tarde']);
    assert.equal(mediaInfo({ message: { locationMessage: { degreesLatitude: -22.3, degreesLongitude: -46.9 } } })!.latitude, -22.3);
    assert.deepEqual(mediaInfo({ message: { contactMessage: { displayName: 'Ana', vcard: 'BEGIN:VCARD\nFN:Ana\nTEL;waid=55:+55 19 9999\nEND:VCARD' } } })!.contacts, [{ name: 'Ana', phones: ['+55 19 9999'] }]);
    const q = mediaInfo({ message: { extendedTextMessage: { text: 'sim', contextInfo: { stanzaId: 'X1', quotedMessage: { conversation: 'Tem vestido azul?' } } } } })!;
    assert.equal(q.quoted?.text, 'Tem vestido azul?');
  });
  it('chamadas (evento e histórico)', () => {
    assert.deepEqual(mediaInfo({ call: { isVideo: true, status: 'timeout' } }), { kind: 'call', isVideo: true, callStatus: 'timeout', duration: undefined });
    assert.equal(mediaInfo({ message: { callLogMesssage: { isVideo: false, durationSecs: 65 } } })!.duration, 65);
  });
  it('toBase64 aceita formatos variados e ignora lixo', () => {
    assert.equal(toBase64([104, 105]), 'aGk=');
    assert.equal(toBase64({ type: 'Buffer', data: [104, 105] }), 'aGk=');
    assert.equal(toBase64(123), undefined);
  });
});
