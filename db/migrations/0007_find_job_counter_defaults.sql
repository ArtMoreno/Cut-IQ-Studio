-- Restore the zero defaults required by the Find Clips job initializer.
-- The application also writes these counters explicitly so a partially
-- drifted local schema cannot prevent a new pipeline from being queued.
ALTER TABLE `find_jobs`
  MODIFY COLUMN `retry_count` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `sources_found` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `transcripts_found` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `candidates_found` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `clips_queued` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `clips_verified` int NOT NULL DEFAULT 0;

ALTER TABLE `find_sources`
  MODIFY COLUMN `attempt_count` int NOT NULL DEFAULT 0;
