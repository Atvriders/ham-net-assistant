-- Manual display order for a session's check-in log.
--
-- The log records the order stations were HEARD. That is not always the order
-- they were typed: an operator who misses a station adds it after the fact and
-- needs to move it into place. Doing that by editing `checkedInAt` would
-- falsify when the entry was made, so the order lives in its own column.
ALTER TABLE "CheckIn" ADD COLUMN "sequence" INTEGER;

-- Backfill every existing row with its current position, so a log that has
-- never been reordered keeps exactly the order it already displayed. Counts
-- how many rows in the same session sort at or before this one by
-- (checkedInAt, id) — giving a dense 1..N per session, ties broken stably.
UPDATE "CheckIn"
SET "sequence" = (
  SELECT COUNT(*)
  FROM "CheckIn" AS prior
  WHERE prior."sessionId" = "CheckIn"."sessionId"
    AND (
      prior."checkedInAt" < "CheckIn"."checkedInAt"
      OR (prior."checkedInAt" = "CheckIn"."checkedInAt" AND prior."id" <= "CheckIn"."id")
    )
);

CREATE INDEX "CheckIn_sessionId_sequence_idx" ON "CheckIn"("sessionId", "sequence");
