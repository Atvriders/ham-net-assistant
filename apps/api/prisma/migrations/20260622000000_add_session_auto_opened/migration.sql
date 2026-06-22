-- AlterTable
ALTER TABLE "NetSession" ADD COLUMN "autoOpened" BOOLEAN NOT NULL DEFAULT false;
-- Existing rows default to false. The auto-open scheduler sets this true when
-- it opens a weekly net's PREP session ~15 minutes before its scheduled start;
-- operator-opened sessions remain false.
