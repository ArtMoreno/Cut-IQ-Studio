CREATE TABLE IF NOT EXISTS `transcript_studio_exports` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `video_fk` bigint unsigned NOT NULL,
  `mode` enum('separate','joined') NOT NULL DEFAULT 'separate',
  `title` varchar(512) NOT NULL,
  `items` text NOT NULL,
  `output_dir` text NOT NULL,
  `status` enum('queued','preparing','rendering','joining','ready','failed','cancelled') NOT NULL DEFAULT 'queued',
  `progress` double NOT NULL DEFAULT 0,
  `stage` varchar(255) NOT NULL DEFAULT 'Queued',
  `output_paths` text,
  `output_path` text,
  `error` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `transcript_studio_exports_video_status_idx` (`video_fk`, `status`)
);
