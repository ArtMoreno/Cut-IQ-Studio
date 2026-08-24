-- Transcript Studio is intentionally additive. These clauses are idempotent
-- because local ClipSift installs may already have received this narrowly
-- scoped schema update through the desktop maintenance workflow.
CREATE TABLE IF NOT EXISTS `transcript_studio_sessions` (
  `video_fk` bigint unsigned NOT NULL,
  `search_query` varchar(512) NOT NULL DEFAULT '',
  `in_point` double,
  `out_point` double,
  `clip_queue` text,
  `source_height` int,
  `source_duration_sec` double,
  `transcript_cache_key` varchar(200),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`video_fk`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `transcript_studio_segment_edits` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `video_fk` bigint unsigned NOT NULL,
  `segment_idx` int NOT NULL,
  `original_text` text NOT NULL,
  `display_text` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `transcript_studio_segment_edits_video_segment_uq` (`video_fk`, `segment_idx`)
);
--> statement-breakpoint
ALTER TABLE `clip_jobs` ADD COLUMN IF NOT EXISTS `output_width` int;
--> statement-breakpoint
ALTER TABLE `clip_jobs` ADD COLUMN IF NOT EXISTS `output_height` int;
--> statement-breakpoint
ALTER TABLE `clip_jobs` ADD COLUMN IF NOT EXISTS `output_duration_sec` double;
--> statement-breakpoint
ALTER TABLE `clip_jobs` ADD COLUMN IF NOT EXISTS `output_has_audio` boolean;
