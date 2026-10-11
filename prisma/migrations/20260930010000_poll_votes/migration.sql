-- Votos de enquete por pessoa (contagem confiável mesmo com votos alterados).
CREATE TABLE "poll_votes" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "poll_votes_instanceId_pollId_voter_key" ON "poll_votes"("instanceId", "pollId", "voter");
CREATE INDEX "poll_votes_instanceId_pollId_idx" ON "poll_votes"("instanceId", "pollId");
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
