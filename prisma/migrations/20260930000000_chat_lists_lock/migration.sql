-- Listas de conversas (favoritas + listas próprias) e conversa trancada no painel.
ALTER TABLE "chats" ADD COLUMN "lists" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "chats" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "chat_lists" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_lists_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_lists_instanceId_idx" ON "chat_lists"("instanceId");
ALTER TABLE "chat_lists" ADD CONSTRAINT "chat_lists_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
