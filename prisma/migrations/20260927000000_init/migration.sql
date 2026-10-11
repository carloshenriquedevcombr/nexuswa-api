-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'client');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'client',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxInstances" INTEGER NOT NULL DEFAULT 1,
    "totpSecretEnc" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" TEXT,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "requestId" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bug_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "instanceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "context" JSONB,
    "requestId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instances" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "systemName" TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "qrcode" TEXT NOT NULL DEFAULT '',
    "paircode" TEXT NOT NULL DEFAULT '',
    "connectedPhone" TEXT NOT NULL DEFAULT '',
    "ownerJid" TEXT NOT NULL DEFAULT '',
    "profileName" TEXT NOT NULL DEFAULT '',
    "profilePicUrl" TEXT NOT NULL DEFAULT '',
    "isBusiness" BOOLEAN NOT NULL DEFAULT false,
    "platform" TEXT NOT NULL DEFAULT '',
    "currentPresence" TEXT NOT NULL DEFAULT 'available',
    "lastDisconnect" TIMESTAMP(3),
    "lastDisconnectReason" TEXT NOT NULL DEFAULT '',
    "pairedAt" TIMESTAMP(3),
    "adminField01" TEXT NOT NULL DEFAULT '',
    "adminField02" TEXT NOT NULL DEFAULT '',
    "msgDelayMin" INTEGER NOT NULL DEFAULT 0,
    "msgDelayMax" INTEGER NOT NULL DEFAULT 2,
    "openaiApiKeyEnc" TEXT,
    "proxyUrlEnc" TEXT,
    "fieldsMap" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_states" (
    "instanceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_states_pkey" PRIMARY KEY ("instanceId", "key")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addUrlEvents" BOOLEAN NOT NULL DEFAULT false,
    "addUrlTypesMessages" BOOLEAN NOT NULL DEFAULT false,
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_webhook" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addUrlEvents" BOOLEAN NOT NULL DEFAULT false,
    "addUrlTypesMessages" BOOLEAN NOT NULL DEFAULT false,
    "secretEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "chatid" TEXT NOT NULL,
    "chatlid" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "pushName" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "isGroupAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isGroupAnnounce" BOOLEAN NOT NULL DEFAULT false,
    "isGroupMember" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "muteEndTime" BIGINT NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "ephemeralExpiration" INTEGER NOT NULL DEFAULT 0,
    "lastMsgTimestamp" BIGINT NOT NULL DEFAULT 0,
    "lastMessageType" TEXT NOT NULL DEFAULT '',
    "lastMessageText" TEXT NOT NULL DEFAULT '',
    "lastMessageSender" TEXT NOT NULL DEFAULT '',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT NOT NULL DEFAULT '',
    "leadName" TEXT NOT NULL DEFAULT '',
    "leadFullName" TEXT NOT NULL DEFAULT '',
    "leadEmail" TEXT NOT NULL DEFAULT '',
    "leadPersonalId" TEXT NOT NULL DEFAULT '',
    "leadStatus" TEXT NOT NULL DEFAULT '',
    "leadNotes" TEXT NOT NULL DEFAULT '',
    "leadTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leadIsTicketOpen" BOOLEAN NOT NULL DEFAULT false,
    "leadAssignedAttendantId" TEXT NOT NULL DEFAULT '',
    "leadKanbanOrder" BIGINT NOT NULL DEFAULT 0,
    "leadFields" JSONB,
    "chatbotDisableUntil" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "lid" TEXT NOT NULL DEFAULT '',
    "fullName" TEXT NOT NULL DEFAULT '',
    "firstName" TEXT NOT NULL DEFAULT '',
    "pushName" TEXT NOT NULL DEFAULT '',
    "businessName" TEXT NOT NULL DEFAULT '',
    "inAddressBook" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "messageid" TEXT NOT NULL,
    "chatid" TEXT NOT NULL,
    "sender" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "messageType" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "quoted" TEXT NOT NULL DEFAULT '',
    "edited" TEXT NOT NULL DEFAULT '',
    "reaction" TEXT NOT NULL DEFAULT '',
    "vote" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "wasSentByApi" BOOLEAN NOT NULL DEFAULT false,
    "sendFunction" TEXT NOT NULL DEFAULT '',
    "sendFolderId" TEXT NOT NULL DEFAULT '',
    "trackSource" TEXT NOT NULL DEFAULT '',
    "trackId" TEXT NOT NULL DEFAULT '',
    "fileURL" TEXT NOT NULL DEFAULT '',
    "transcription" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB,
    "messageTimestamp" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "labelid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kanban" BOOLEAN NOT NULL DEFAULT false,
    "kanbanOrder" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quick_replies" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "shortCut" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL DEFAULT '',
    "file" TEXT NOT NULL DEFAULT '',
    "docName" TEXT NOT NULL DEFAULT '',
    "onWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_folders" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "info" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduledFor" BIGINT NOT NULL DEFAULT 0,
    "nextSendAt" BIGINT NOT NULL DEFAULT 0,
    "delayMin" INTEGER NOT NULL DEFAULT 10,
    "delayMax" INTEGER NOT NULL DEFAULT 30,
    "logTotal" INTEGER NOT NULL DEFAULT 0,
    "logSuccess" INTEGER NOT NULL DEFAULT 0,
    "logFailed" INTEGER NOT NULL DEFAULT 0,
    "logDelivered" INTEGER NOT NULL DEFAULT 0,
    "logRead" INTEGER NOT NULL DEFAULT 0,
    "logPlayed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_messages" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "error" TEXT NOT NULL DEFAULT '',
    "messageid" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorType_actorId_idx" ON "audit_logs"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "bug_reports_status_createdAt_idx" ON "bug_reports"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "instances_tokenHash_key" ON "instances"("tokenHash");

-- CreateIndex
CREATE INDEX "instances_ownerId_idx" ON "instances"("ownerId");

-- CreateIndex
CREATE INDEX "instances_status_idx" ON "instances"("status");

-- CreateIndex
CREATE INDEX "webhooks_instanceId_idx" ON "webhooks"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "chats_instanceId_chatid_key" ON "chats"("instanceId", "chatid");

-- CreateIndex
CREATE INDEX "chats_instanceId_lastMsgTimestamp_idx" ON "chats"("instanceId", "lastMsgTimestamp");

-- CreateIndex
CREATE INDEX "chats_instanceId_leadStatus_idx" ON "chats"("instanceId", "leadStatus");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_instanceId_jid_key" ON "contacts"("instanceId", "jid");

-- CreateIndex
CREATE INDEX "contacts_instanceId_inAddressBook_idx" ON "contacts"("instanceId", "inAddressBook");

-- CreateIndex
CREATE INDEX "messages_instanceId_chatid_messageTimestamp_idx" ON "messages"("instanceId", "chatid", "messageTimestamp");

-- CreateIndex
CREATE INDEX "messages_instanceId_messageid_idx" ON "messages"("instanceId", "messageid");

-- CreateIndex
CREATE INDEX "messages_instanceId_trackSource_trackId_idx" ON "messages"("instanceId", "trackSource", "trackId");

-- CreateIndex
CREATE INDEX "messages_instanceId_status_idx" ON "messages"("instanceId", "status");

-- CreateIndex
CREATE INDEX "messages_createdAt_idx" ON "messages"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "labels_instanceId_labelid_key" ON "labels"("instanceId", "labelid");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tags_instanceId_name_key" ON "lead_tags"("instanceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "quick_replies_instanceId_shortCut_key" ON "quick_replies"("instanceId", "shortCut");

-- CreateIndex
CREATE INDEX "campaign_folders_instanceId_status_idx" ON "campaign_folders"("instanceId", "status");

-- CreateIndex
CREATE INDEX "campaign_folders_status_nextSendAt_idx" ON "campaign_folders"("status", "nextSendAt");

-- CreateIndex
CREATE INDEX "campaign_messages_folderId_status_position_idx" ON "campaign_messages"("folderId", "status", "position");

-- CreateIndex
CREATE INDEX "campaign_messages_instanceId_messageid_idx" ON "campaign_messages"("instanceId", "messageid");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_folders" ADD CONSTRAINT "campaign_folders_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "campaign_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
