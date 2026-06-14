-- AlterTable
ALTER TABLE "NetSession" ADD COLUMN "liveAt" DATETIME;

-- Backfill: every existing session was "live" the moment it was created (the
-- previous one-step OPEN-and-START flow). Set liveAt = startedAt so the prep
-- state is opt-in only — existing rows behave exactly as they did before.
UPDATE "NetSession" SET "liveAt" = "startedAt" WHERE "liveAt" IS NULL;
