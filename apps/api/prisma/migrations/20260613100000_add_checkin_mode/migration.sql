-- AlterTable
ALTER TABLE "CheckIn" ADD COLUMN "mode" TEXT;
-- Leave existing rows NULL; the application treats NULL as 'rf' (local
-- repeater RF — the default for the FCC-friendly log). New rows may
-- record 'echolink' for VoIP participation; the column is intentionally
-- a free-form string so future modes (e.g. 'allstar', 'irlp') don't
-- require another migration.
