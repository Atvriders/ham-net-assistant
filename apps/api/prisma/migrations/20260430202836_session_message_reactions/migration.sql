-- CreateTable
CREATE TABLE "SessionMessageReaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "authorTag" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SessionMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionMessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionMessageReaction_messageId_idx" ON "SessionMessageReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMessageReaction_messageId_emoji_userId_authorTag_key" ON "SessionMessageReaction"("messageId", "emoji", "userId", "authorTag");
