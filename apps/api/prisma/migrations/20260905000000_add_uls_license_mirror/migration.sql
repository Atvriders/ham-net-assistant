-- Local mirror of the FCC ULS amateur licence database, plus the import log.
--
-- Purely additive: two CREATE TABLE and two CREATE INDEX statements, nothing
-- else. `prisma migrate deploy` runs unattended on every club's container boot
-- against the live SQLite file in the /data volume, so nothing here may rewrite,
-- copy, or drop an existing table. Applying this to a populated database only
-- appends two empty tables; every existing row and index is untouched, and a
-- club that never enables the importer just carries two empty tables.

-- CreateTable
CREATE TABLE "UlsLicense" (
    "callsign" TEXT NOT NULL PRIMARY KEY,
    "usi" INTEGER NOT NULL,
    "name" TEXT,
    "operatorClass" TEXT,
    "status" TEXT,
    "city" TEXT,
    "state" TEXT,
    "statusGeneration" INTEGER
);

-- CreateTable
CREATE TABLE "UlsImportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "generation" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "outcome" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceFileDate" TEXT,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "callsigns" INTEGER NOT NULL DEFAULT 0,
    "malformedRows" INTEGER NOT NULL DEFAULT 0,
    "removedRows" INTEGER NOT NULL DEFAULT 0,
    "bytesRead" INTEGER NOT NULL DEFAULT 0,
    "unnamedCallsigns" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT
);

-- Read only by the post-import sweep ("delete every row the newest completed
-- import did not confirm ACTIVE"). The lookup path never touches it.
-- CreateIndex
CREATE INDEX "UlsLicense_statusGeneration_idx" ON "UlsLicense"("statusGeneration");

-- CreateIndex
CREATE INDEX "UlsImportRun_startedAt_idx" ON "UlsImportRun"("startedAt");
