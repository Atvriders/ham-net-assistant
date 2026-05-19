-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastSeenAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Net" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weekly',
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
