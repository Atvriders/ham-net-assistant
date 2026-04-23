-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "NetSession" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "CheckIn_deletedAt_idx" ON "CheckIn"("deletedAt");

-- CreateIndex
CREATE INDEX "NetSession_deletedAt_idx" ON "NetSession"("deletedAt");
