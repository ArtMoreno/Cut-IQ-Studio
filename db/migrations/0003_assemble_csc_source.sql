-- Assemble: allow a CSC job folder (the automation pipeline's on-disk output)
-- to be the project's clip source, beside the in-app script project.
ALTER TABLE `assemble_projects` ADD COLUMN IF NOT EXISTS `source_csc_slug` varchar(255);
