-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callsign" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "collegeSlug" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Repeater" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "frequency" REAL NOT NULL,
    "offsetKhz" INTEGER NOT NULL,
    "toneHz" REAL,
    "mode" TEXT NOT NULL,
    "coverage" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Net" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repeaterId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startLocal" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "theme" TEXT,
    "scriptMd" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Net_repeaterId_fkey" FOREIGN KEY ("repeaterId") REFERENCES "Repeater" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NetSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "netId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "controlOpId" TEXT,
    "notes" TEXT,
    CONSTRAINT "NetSession_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NetSession_controlOpId_fkey" FOREIGN KEY ("controlOpId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "callsign" TEXT NOT NULL,
    "nameAtCheckIn" TEXT NOT NULL,
    "checkedInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,
    CONSTRAINT "CheckIn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NetSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_callsign_key" ON "User"("callsign");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CheckIn_sessionId_idx" ON "CheckIn"("sessionId");

-- CreateIndex
CREATE INDEX "CheckIn_callsign_idx" ON "CheckIn"("callsign");
