-- DropIndex
DROP INDEX "User_callsign_key";

-- CreateIndex
CREATE INDEX "User_callsign_idx" ON "User"("callsign");
