-- Filtro opcional de chats por webhook (vazio = todos os chats).
-- Nullable com default, no mesmo padrão das outras listas: linhas antigas ficam válidas sem reescrita.
ALTER TABLE "webhooks" ADD COLUMN "onlyChats" TEXT[] DEFAULT ARRAY[]::TEXT[];
