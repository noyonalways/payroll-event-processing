-- Record every processing attempt (one row per attempt number per event).
-- The UNIQUE (event_id, attempt_number) constraint is the write-side invariant
-- for the per-attempt audit trail: transient retries, the terminal SUCCESS /
-- FAILED(PERMANENT) commit, and the exhaustion upsert all target the same
-- one-row-per-attempt space. Existing data already satisfies it (at most one
-- terminal row per event), so the constraint is safe to add as-is.

-- CreateIndex
CREATE UNIQUE INDEX "event_attempts_event_id_attempt_number_key" ON "event_attempts"("event_id", "attempt_number");