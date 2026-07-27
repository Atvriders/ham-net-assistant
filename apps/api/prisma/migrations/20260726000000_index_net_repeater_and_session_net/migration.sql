-- Purely additive: CREATE INDEX only. `prisma migrate deploy` runs unattended
-- on every container boot against the live SQLite file in the /data volume, so
-- nothing here may rewrite or copy a table.

-- Hottest predicate in the app: sessions for one net, always range-filtered or
-- ordered by startedAt (net session list, active-session lookup, the log-import
-- and auto-open same-calendar-day dedupe). Previously a full scan of NetSession.
CREATE INDEX "NetSession_netId_startedAt_idx" ON "NetSession"("netId", "startedAt");

-- Repeater -> nets, walked by the repeater stats/detail queries and by the
-- ON DELETE CASCADE when a repeater is removed.
CREATE INDEX "Net_repeaterId_idx" ON "Net"("repeaterId");
