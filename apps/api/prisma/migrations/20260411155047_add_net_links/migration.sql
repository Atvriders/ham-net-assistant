-- CreateTable
CREATE TABLE "NetLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "netId" TEXT NOT NULL,
    "repeaterId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetLink_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NetLink_repeaterId_fkey" FOREIGN KEY ("repeaterId") REFERENCES "Repeater" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NetLink_netId_idx" ON "NetLink"("netId");

-- CreateIndex
CREATE UNIQUE INDEX "NetLink_netId_repeaterId_key" ON "NetLink"("netId", "repeaterId");
