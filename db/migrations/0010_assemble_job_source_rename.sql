-- Assemble: drop the client-specific naming from the pipeline job source.
-- `source_csc_slug` becomes `source_job_slug`, and the vertical preset is named
-- for its aspect ratio rather than the job type it was first built for.
--
-- Guarded so a fresh install (which already gets the new names from
-- installer/schema.sql) and a re-run both succeed.

SET @rename_needed := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'assemble_projects'
    AND COLUMN_NAME = 'source_csc_slug'
);

SET @stmt := IF(
  @rename_needed > 0,
  'ALTER TABLE `assemble_projects` CHANGE `source_csc_slug` `source_job_slug` varchar(255) DEFAULT NULL',
  'DO 0'
);
PREPARE rename_col FROM @stmt;
EXECUTE rename_col;
DEALLOCATE PREPARE rename_col;

ALTER TABLE `assemble_projects` ALTER `preset` SET DEFAULT 'vertical-9x16';
UPDATE `assemble_projects` SET `preset` = 'vertical-9x16' WHERE `preset` = 'csc-vertical';
