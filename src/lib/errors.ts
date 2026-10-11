/**
 * Erros de domínio com status HTTP explícito.
 * Por quê: o handler global só expõe `message` de HttpError; qualquer outra exceção
 * vira 500 genérico — stack trace e detalhes internos nunca chegam ao cliente.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorKey?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'Credencial ausente ou inválida') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Operação não permitida') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Recurso não encontrado') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');
export const tooMany = (msg = 'Muitas requisições') => new HttpError(429, msg, 'rate_limited');
export const notImplemented = (msg: string) => new HttpError(501, msg, 'not_supported');
export const unavailable = (msg: string) => new HttpError(503, msg, 'unavailable');
