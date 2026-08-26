/*M!999999\- enable the sandbox mode */
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `__drizzle_migrations` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `hash` text NOT NULL,
  `created_at` bigint(20) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assemble_autosaves` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_fk` bigint(20) unsigned NOT NULL,
  `doc` text NOT NULL,
  `reason` varchar(60) NOT NULL DEFAULT 'autosave',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assemble_projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `source_project_fk` bigint(20) unsigned DEFAULT NULL,
  `doc` text NOT NULL,
  `preset` varchar(32) NOT NULL DEFAULT 'vertical-9x16',
  `status` varchar(40) NOT NULL DEFAULT 'draft',
  `render_log` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `source_job_slug` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `clip_candidates` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_fk` bigint(20) unsigned NOT NULL,
  `revision_fk` bigint(20) unsigned NOT NULL,
  `beat_fk` bigint(20) unsigned NOT NULL,
  `provider` varchar(40) NOT NULL,
  `video_fk` bigint(20) unsigned DEFAULT NULL,
  `source_url` text NOT NULL,
  `source_account` varchar(300) DEFAULT NULL,
  `title` varchar(512) DEFAULT NULL,
  `published_at` varchar(64) DEFAULT NULL,
  `duration_sec` double DEFAULT NULL,
  `thumbnail_url` text DEFAULT NULL,
  `match_kind` enum('exact_transcript','strong_visual','probable_visual','broad_candidate','manual_review') NOT NULL DEFAULT 'manual_review',
  `transcript_excerpt` text DEFAULT NULL,
  `seg_start` double DEFAULT NULL,
  `seg_end` double DEFAULT NULL,
  `edit_in` double DEFAULT NULL,
  `edit_out` double DEFAULT NULL,
  `relevance_score` double NOT NULL DEFAULT 0,
  `quality_score` double NOT NULL DEFAULT 0,
  `clean_source_score` double NOT NULL DEFAULT 0,
  `visual_confidence` double NOT NULL DEFAULT 0,
  `reason` text DEFAULT NULL,
  `acquisition_status` varchar(60) NOT NULL DEFAULT 'metadata_only',
  `dup_group_key` varchar(80) DEFAULT NULL,
  `state` enum('undecided','approved','rejected') NOT NULL DEFAULT 'undecided',
  `user_notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `clip_jobs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `kind` enum('candidate','moment') NOT NULL,
  `project_fk` bigint(20) unsigned DEFAULT NULL,
  `candidate_fk` bigint(20) unsigned DEFAULT NULL,
  `moment_fk` bigint(20) unsigned DEFAULT NULL,
  `video_fk` bigint(20) unsigned DEFAULT NULL,
  `source_url` text NOT NULL,
  `title` varchar(512) NOT NULL,
  `file_name` varchar(512) DEFAULT NULL,
  `edit_in` double NOT NULL,
  `edit_out` double NOT NULL,
  `height` int(11) NOT NULL DEFAULT 720,
  `minimum_height` int(11) NOT NULL DEFAULT 720,
  `upload_to_drive` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('queued','downloading','uploading','ready','failed','cancelled') NOT NULL DEFAULT 'queued',
  `progress` double NOT NULL DEFAULT 0,
  `stage` varchar(200) NOT NULL DEFAULT 'queued',
  `output_path` text DEFAULT NULL,
  `file_size_bytes` bigint(20) DEFAULT NULL,
  `drive_path` text DEFAULT NULL,
  `error` text DEFAULT NULL,
  `diagnostic_error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `output_width` int(11) DEFAULT NULL,
  `output_height` int(11) DEFAULT NULL,
  `output_duration_sec` double DEFAULT NULL,
  `output_has_audio` tinyint(1) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `clip_package_edit_versions` (
  `id` varchar(36) NOT NULL,
  `project_fk` bigint(20) unsigned NOT NULL,
  `candidate_fk` bigint(20) unsigned NOT NULL,
  `source_video_fk` bigint(20) unsigned NOT NULL,
  `source_clip_job_fk` bigint(20) unsigned NOT NULL,
  `studio_export_fk` bigint(20) unsigned DEFAULT NULL,
  `studio_draft_id` varchar(120) DEFAULT NULL,
  `intent` enum('new_version','replacement') NOT NULL DEFAULT 'new_version',
  `status` enum('draft','exporting','ready','failed','retired') NOT NULL DEFAULT 'draft',
  `active_replacement` tinyint(1) NOT NULL DEFAULT 0,
  `original_in` double NOT NULL,
  `original_out` double NOT NULL,
  `edit_in` double NOT NULL,
  `edit_out` double NOT NULL,
  `drive_path` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `clip_package_edit_versions_project_candidate_idx` (`project_fk`,`candidate_fk`),
  KEY `clip_package_edit_versions_studio_export_idx` (`studio_export_fk`),
  KEY `clip_package_edit_versions_active_idx` (`project_fk`,`candidate_fk`,`active_replacement`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `find_jobs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_fk` bigint(20) unsigned NOT NULL,
  `player` varchar(255) NOT NULL,
  `team` varchar(255) NOT NULL,
  `season` int(11) NOT NULL,
  `opponent` varchar(255) DEFAULT NULL,
  `source_limit` int(11) NOT NULL DEFAULT 20,
  `clip_limit` int(11) NOT NULL DEFAULT 30,
  `preferred_height` int(11) NOT NULL DEFAULT 1080,
  `minimum_height` int(11) NOT NULL DEFAULT 720,
  `pre_roll_sec` double NOT NULL DEFAULT 10,
  `post_roll_sec` double NOT NULL DEFAULT 15,
  `local_asr_fallback` tinyint(1) NOT NULL DEFAULT 1,
  `highlight_tuner_settings` text DEFAULT NULL,
  `player_match_tuning` varchar(16) DEFAULT NULL,
  `status` varchar(48) NOT NULL DEFAULT 'queued',
  `stage` varchar(80) NOT NULL DEFAULT 'queued',
  `progress_percent` double NOT NULL DEFAULT 0,
  `current_operation` text DEFAULT NULL,
  `pause_requested` tinyint(1) NOT NULL DEFAULT 0,
  `cancel_requested` tinyint(1) NOT NULL DEFAULT 0,
  `retry_count` int(11) NOT NULL DEFAULT 0,
  `max_retries` int(11) NOT NULL DEFAULT 3,
  `sources_found` int(11) NOT NULL DEFAULT 0,
  `transcripts_found` int(11) NOT NULL DEFAULT 0,
  `candidates_found` int(11) NOT NULL DEFAULT 0,
  `clips_queued` int(11) NOT NULL DEFAULT 0,
  `clips_verified` int(11) NOT NULL DEFAULT 0,
  `warnings` text DEFAULT NULL,
  `last_error` text DEFAULT NULL,
  `last_progress_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `worker_heartbeat_at` timestamp NULL DEFAULT NULL,
  `started_at` timestamp NULL DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `find_jobs_project_uq` (`project_fk`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `find_sources` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `job_fk` bigint(20) unsigned NOT NULL,
  `project_fk` bigint(20) unsigned NOT NULL,
  `video_id` varchar(32) NOT NULL,
  `video_fk` bigint(20) unsigned DEFAULT NULL,
  `url` text NOT NULL,
  `title` varchar(512) DEFAULT NULL,
  `channel` varchar(255) DEFAULT NULL,
  `duration_sec` int(11) DEFAULT NULL,
  `published_at` varchar(64) DEFAULT NULL,
  `search_query` varchar(512) DEFAULT NULL,
  `source_type` varchar(64) NOT NULL DEFAULT 'youtube',
  `rank_score` double NOT NULL DEFAULT 0,
  `caption_kind` varchar(32) DEFAULT NULL,
  `status` varchar(48) NOT NULL DEFAULT 'metadata',
  `attempt_count` int(11) NOT NULL DEFAULT 0,
  `last_error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `find_sources_job_video_uq` (`job_fk`,`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `moments` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_fk` bigint(20) unsigned NOT NULL,
  `title` varchar(512) NOT NULL,
  `note` text DEFAULT NULL,
  `start` double NOT NULL,
  `end` double DEFAULT NULL,
  `excerpt` text DEFAULT NULL,
  `color` varchar(32) NOT NULL DEFAULT 'amber',
  `status` enum('candidate','selected','used') NOT NULL DEFAULT 'candidate',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `script_beats` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_fk` bigint(20) unsigned NOT NULL,
  `revision_fk` bigint(20) unsigned NOT NULL,
  `ord` int(11) NOT NULL,
  `text` text NOT NULL,
  `entities` text DEFAULT NULL,
  `aliases` text DEFAULT NULL,
  `purpose` varchar(40) DEFAULT NULL,
  `coverage_types` text DEFAULT NULL,
  `needs_transcript_search` tinyint(1) NOT NULL DEFAULT 1,
  `visual_only` tinyint(1) NOT NULL DEFAULT 0,
  `desired_clip_len_sec` double DEFAULT NULL,
  `queries` text DEFAULT NULL,
  `uncertainty` text DEFAULT NULL,
  `status` enum('pending','covered','needs_footage') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `script_projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `topic` varchar(255) DEFAULT NULL,
  `tags` text DEFAULT NULL,
  `source_provider` varchar(40) NOT NULL DEFAULT 'manual',
  `source_doc_id` varchar(128) DEFAULT NULL,
  `source_title` varchar(512) DEFAULT NULL,
  `source_url` text DEFAULT NULL,
  `source_modified_at` varchar(64) DEFAULT NULL,
  `status` enum('imported','analyzing','building_coverage','searching_sources','fetching_transcripts','ranking_candidates','ready_for_review','partially_complete','failed') NOT NULL DEFAULT 'imported',
  `current_revision` int(11) NOT NULL DEFAULT 1,
  `preroll_sec` double NOT NULL DEFAULT 3,
  `postroll_sec` double NOT NULL DEFAULT 1.5,
  `default_clip_len_sec` double NOT NULL DEFAULT 8,
  `pipeline_log` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `script_revisions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_fk` bigint(20) unsigned NOT NULL,
  `revision` int(11) NOT NULL,
  `script_text` text NOT NULL,
  `script_hash` varchar(64) NOT NULL,
  `extracted_from_heading` varchar(200) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `script_search_cache` (
  `cache_key` varchar(200) NOT NULL,
  `payload` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `expires_at` bigint(20) NOT NULL,
  PRIMARY KEY (`cache_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `search_history` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_fk` bigint(20) unsigned NOT NULL,
  `query` varchar(512) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `transcript_segments` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_fk` bigint(20) unsigned NOT NULL,
  `idx` int(11) NOT NULL,
  `text` text NOT NULL,
  `start` double NOT NULL,
  `end` double NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `transcript_studio_exports` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_fk` bigint(20) unsigned NOT NULL,
  `mode` enum('separate','joined') NOT NULL DEFAULT 'separate',
  `title` varchar(512) NOT NULL,
  `items` text NOT NULL,
  `output_dir` text NOT NULL,
  `status` enum('queued','preparing','rendering','joining','ready','failed','cancelled') NOT NULL DEFAULT 'queued',
  `progress` double NOT NULL DEFAULT 0,
  `stage` varchar(255) NOT NULL DEFAULT 'Queued',
  `output_paths` text DEFAULT NULL,
  `output_path` text DEFAULT NULL,
  `error` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `transcript_studio_exports_video_status_idx` (`video_fk`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `transcript_studio_segment_edits` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_fk` bigint(20) unsigned NOT NULL,
  `segment_idx` int(11) NOT NULL,
  `original_text` text NOT NULL,
  `display_text` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `transcript_studio_segment_edits_video_segment_uq` (`video_fk`,`segment_idx`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `transcript_studio_sessions` (
  `video_fk` bigint(20) unsigned NOT NULL,
  `search_query` varchar(512) NOT NULL DEFAULT '',
  `in_point` double DEFAULT NULL,
  `out_point` double DEFAULT NULL,
  `clip_queue` text DEFAULT NULL,
  `source_height` int(11) DEFAULT NULL,
  `source_duration_sec` double DEFAULT NULL,
  `transcript_cache_key` varchar(200) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`video_fk`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `videos` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `video_id` varchar(32) NOT NULL,
  `url` text NOT NULL,
  `title` varchar(512) DEFAULT NULL,
  `channel` varchar(255) DEFAULT NULL,
  `thumbnail` text DEFAULT NULL,
  `duration_sec` int(11) DEFAULT NULL,
  `transcript_lang` varchar(32) DEFAULT NULL,
  `transcript_kind` enum('manual','auto','local-whisper','imported','none') NOT NULL DEFAULT 'none',
  `status` enum('ok','no_transcript','error') NOT NULL DEFAULT 'ok',
  `error_message` text DEFAULT NULL,
  `favorite` tinyint(1) NOT NULL DEFAULT 0,
  `archived` tinyint(1) NOT NULL DEFAULT 0,
  `project_id` bigint(20) unsigned DEFAULT NULL,
  `last_position` double NOT NULL DEFAULT 0,
  `last_opened_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `retrieved_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `videos_video_id_unique` (`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;
