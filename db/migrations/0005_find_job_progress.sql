ALTER TABLE `find_jobs`
  ADD COLUMN `progress_percent` double NOT NULL DEFAULT 0 AFTER `stage`;

UPDATE `find_jobs`
SET `progress_percent` = CASE
  WHEN `stage` = 'complete' THEN 100
  WHEN `stage` = 'verifying' THEN 90
  WHEN `stage` = 'extracting' THEN 75
  WHEN `stage` = 'ranking' THEN 65
  WHEN `stage` = 'transcripts' THEN 45
  WHEN `stage` = 'discovering' THEN 20
  WHEN `stage` = 'analyzing' THEN 5
  ELSE 0
END;

ALTER TABLE `clip_jobs`
  ADD COLUMN `diagnostic_error` text NULL AFTER `error`;
