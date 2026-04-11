-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NetSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "netId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "controlOpId" TEXT,
    "notes" TEXT,
    "topicId" TEXT,
    "topicTitle" TEXT,
    CONSTRAINT "NetSession_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NetSession_controlOpId_fkey" FOREIGN KEY ("controlOpId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NetSession_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "TopicSuggestion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_NetSession" ("controlOpId", "endedAt", "id", "netId", "notes", "startedAt") SELECT "controlOpId", "endedAt", "id", "netId", "notes", "startedAt" FROM "NetSession";
DROP TABLE "NetSession";
ALTER TABLE "new_NetSession" RENAME TO "NetSession";
CREATE INDEX "NetSession_startedAt_idx" ON "NetSession"("startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
