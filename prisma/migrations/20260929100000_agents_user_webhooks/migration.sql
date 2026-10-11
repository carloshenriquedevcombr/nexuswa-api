-- Atendentes (vários usuários no mesmo número) e webhook por conta.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'agent';

ALTER TABLE "users" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "users_ownerUserId_idx" ON "users"("ownerUserId");

CREATE TABLE "instance_agents" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'available',
    "pauseReason" TEXT NOT NULL DEFAULT '',
    "pausedUntil" TIMESTAMP(3),
    "breakStart" TEXT NOT NULL DEFAULT '',
    "breakEnd" TEXT NOT NULL DEFAULT '',
    "lastAssignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "instance_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instance_agents_instanceId_userId_key" ON "instance_agents"("instanceId", "userId");
CREATE INDEX "instance_agents_userId_idx" ON "instance_agents"("userId");
ALTER TABLE "instance_agents" ADD CONSTRAINT "instance_agents_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "instance_agents" ADD CONSTRAINT "instance_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_webhooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onlyChats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addUrlEvents" BOOLEAN NOT NULL DEFAULT false,
    "addUrlTypesMessages" BOOLEAN NOT NULL DEFAULT false,
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_webhooks_userId_idx" ON "user_webhooks"("userId");
ALTER TABLE "user_webhooks" ADD CONSTRAINT "user_webhooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "chats_instanceId_leadAssignedAttendantId_idx" ON "chats"("instanceId", "leadAssignedAttendantId");
CREATE INDEX "chats_instanceId_leadIsTicketOpen_idx" ON "chats"("instanceId", "leadIsTicketOpen");
