import type { Instance } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'client' | 'agent';
  maxInstances: number;
}

export interface AuthContext {
  /** Autenticado via header `admintoken` (automação de servidor). */
  adminToken: boolean;
  /** Usuário humano autenticado via JWT (cookie ou Bearer). */
  user?: AuthUser;
  /** Como o JWT chegou — define se a proteção CSRF se aplica. */
  via?: 'cookie' | 'bearer';
  /** Instância resolvida a partir do token OU de X-Instance-Id + ownership. */
  instance?: Instance;
  instanceVia?: 'token' | 'user' | 'agent';
  /** Preenchido quando quem acessa a instância é um ATENDENTE (acesso restrito às conversas dele). */
  agent?: { userId: string };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      auth: AuthContext;
    }
  }
}

export {};
