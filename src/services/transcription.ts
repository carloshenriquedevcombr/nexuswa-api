import https from 'node:https';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';

/**
 * Transcrição de áudio via API compatível com OpenAI (Whisper).
 * O destino é fixo pelo .env (OPENAI_BASE_URL) — o usuário escolhe apenas a chave,
 * nunca a URL, então não há vetor de SSRF aqui.
 */
export async function transcribe(audio: Buffer, mimetype: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new HttpError(400, 'Transcrição requer openai_apikey (na requisição, na instância ou no servidor)', 'missing_api_key');
  const boundary = `----nexuswa${Date.now().toString(16)}`;
  const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('ogg') ? 'ogg' : 'm4a';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
  );
  const body = Buffer.concat([head, audio, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const url = new URL(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 300) return reject(new HttpError(502, `Falha na transcrição (HTTP ${res.statusCode})`, 'transcription_failed'));
          try {
            resolve(String((JSON.parse(txt) as { text?: string }).text ?? ''));
          } catch {
            reject(new HttpError(502, 'Resposta inválida do serviço de transcrição', 'transcription_failed'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new HttpError(504, 'Transcrição excedeu o tempo limite', 'timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
