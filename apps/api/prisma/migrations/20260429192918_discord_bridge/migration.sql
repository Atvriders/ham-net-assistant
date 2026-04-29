-- CreateTable
CREATE TABLE "NetReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "netId" TEXT NOT NULL,
    "occursAt" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetReminder_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscordRelay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discordMessageId" TEXT NOT NULL,
    "sessionMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "NetReminder_occursAt_idx" ON "NetReminder"("occursAt");

-- CreateIndex
CREATE UNIQUE INDEX "NetReminder_netId_occursAt_kind_key" ON "NetReminder"("netId", "occursAt", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordRelay_discordMessageId_key" ON "DiscordRelay"("discordMessageId");

-- CreateIndex
CREATE INDEX "DiscordRelay_sessionMessageId_idx" ON "DiscordRelay"("sessionMessageId");
