-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CheckIn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "createdById" TEXT,
    "callsign" TEXT NOT NULL,
    "nameAtCheckIn" TEXT NOT NULL,
    "checkedInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,
    CONSTRAINT "CheckIn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NetSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CheckIn_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CheckIn" ("callsign", "checkedInAt", "comment", "id", "nameAtCheckIn", "sessionId", "userId") SELECT "callsign", "checkedInAt", "comment", "id", "nameAtCheckIn", "sessionId", "userId" FROM "CheckIn";
DROP TABLE "CheckIn";
ALTER TABLE "new_CheckIn" RENAME TO "CheckIn";
CREATE INDEX "CheckIn_sessionId_idx" ON "CheckIn"("sessionId");
CREATE INDEX "CheckIn_callsign_idx" ON "CheckIn"("callsign");
CREATE INDEX "CheckIn_checkedInAt_idx" ON "CheckIn"("checkedInAt");
CREATE TABLE "new_Net" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repeaterId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startLocal" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "theme" TEXT,
    "scriptMd" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Net_repeaterId_fkey" FOREIGN KEY ("repeaterId") REFERENCES "Repeater" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Net" ("active", "dayOfWeek", "id", "name", "repeaterId", "scriptMd", "startLocal", "theme", "timezone") SELECT "active", "dayOfWeek", "id", "name", "repeaterId", "scriptMd", "startLocal", "theme", "timezone" FROM "Net";
DROP TABLE "Net";
ALTER TABLE "new_Net" RENAME TO "Net";
CREATE TABLE "new_NetSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "netId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "controlOpId" TEXT,
    "notes" TEXT,
    CONSTRAINT "NetSession_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NetSession_controlOpId_fkey" FOREIGN KEY ("controlOpId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_NetSession" ("controlOpId", "endedAt", "id", "netId", "notes", "startedAt") SELECT "controlOpId", "endedAt", "id", "netId", "notes", "startedAt" FROM "NetSession";
DROP TABLE "NetSession";
ALTER TABLE "new_NetSession" RENAME TO "NetSession";
CREATE INDEX "NetSession_startedAt_idx" ON "NetSession"("startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
