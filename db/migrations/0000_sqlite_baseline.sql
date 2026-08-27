CREATE TABLE `assemble_autosaves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_fk` integer NOT NULL,
	`doc` text NOT NULL,
	`reason` text DEFAULT 'autosave' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assemble_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source_project_fk` integer,
	`source_job_slug` text,
	`doc` text NOT NULL,
	`preset` text DEFAULT 'vertical-9x16' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`render_log` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clip_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_fk` integer NOT NULL,
	`revision_fk` integer NOT NULL,
	`beat_fk` integer NOT NULL,
	`provider` text NOT NULL,
	`video_fk` integer,
	`source_url` text NOT NULL,
	`source_account` text,
	`title` text,
	`published_at` text,
	`duration_sec` real,
	`thumbnail_url` text,
	`match_kind` text DEFAULT 'manual_review' NOT NULL,
	`transcript_excerpt` text,
	`seg_start` real,
	`seg_end` real,
	`edit_in` real,
	`edit_out` real,
	`relevance_score` real DEFAULT 0 NOT NULL,
	`quality_score` real DEFAULT 0 NOT NULL,
	`clean_source_score` real DEFAULT 0 NOT NULL,
	`visual_confidence` real DEFAULT 0 NOT NULL,
	`reason` text,
	`acquisition_status` text DEFAULT 'metadata_only' NOT NULL,
	`dup_group_key` text,
	`state` text DEFAULT 'undecided' NOT NULL,
	`user_notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clip_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`project_fk` integer,
	`candidate_fk` integer,
	`moment_fk` integer,
	`video_fk` integer,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`file_name` text,
	`edit_in` real NOT NULL,
	`edit_out` real NOT NULL,
	`height` integer DEFAULT 720 NOT NULL,
	`minimum_height` integer DEFAULT 720 NOT NULL,
	`upload_to_drive` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`output_path` text,
	`file_size_bytes` integer,
	`output_width` integer,
	`output_height` integer,
	`output_duration_sec` real,
	`output_has_audio` integer,
	`drive_path` text,
	`error` text,
	`diagnostic_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clip_package_edit_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_fk` integer NOT NULL,
	`candidate_fk` integer NOT NULL,
	`source_video_fk` integer NOT NULL,
	`source_clip_job_fk` integer NOT NULL,
	`studio_export_fk` integer,
	`studio_draft_id` text,
	`intent` text DEFAULT 'new_version' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`active_replacement` integer DEFAULT false NOT NULL,
	`original_in` real NOT NULL,
	`original_out` real NOT NULL,
	`edit_in` real NOT NULL,
	`edit_out` real NOT NULL,
	`drive_path` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clip_package_edit_versions_project_candidate_idx` ON `clip_package_edit_versions` (`project_fk`,`candidate_fk`);--> statement-breakpoint
CREATE INDEX `clip_package_edit_versions_studio_export_idx` ON `clip_package_edit_versions` (`studio_export_fk`);--> statement-breakpoint
CREATE INDEX `clip_package_edit_versions_active_idx` ON `clip_package_edit_versions` (`project_fk`,`candidate_fk`,`active_replacement`);--> statement-breakpoint
CREATE TABLE `find_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_fk` integer NOT NULL,
	`player` text NOT NULL,
	`team` text NOT NULL,
	`season` integer NOT NULL,
	`opponent` text,
	`source_limit` integer DEFAULT 20 NOT NULL,
	`clip_limit` integer DEFAULT 30 NOT NULL,
	`preferred_height` integer DEFAULT 1080 NOT NULL,
	`minimum_height` integer DEFAULT 720 NOT NULL,
	`pre_roll_sec` real DEFAULT 10 NOT NULL,
	`post_roll_sec` real DEFAULT 15 NOT NULL,
	`local_asr_fallback` integer DEFAULT true NOT NULL,
	`highlight_tuner_settings` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`progress_percent` real DEFAULT 0 NOT NULL,
	`current_operation` text,
	`pause_requested` integer DEFAULT false NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`sources_found` integer DEFAULT 0 NOT NULL,
	`transcripts_found` integer DEFAULT 0 NOT NULL,
	`candidates_found` integer DEFAULT 0 NOT NULL,
	`clips_queued` integer DEFAULT 0 NOT NULL,
	`clips_verified` integer DEFAULT 0 NOT NULL,
	`warnings` text,
	`last_error` text,
	`last_progress_at` integer DEFAULT (unixepoch()) NOT NULL,
	`worker_heartbeat_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `find_jobs_project_uq` ON `find_jobs` (`project_fk`);--> statement-breakpoint
CREATE TABLE `find_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_fk` integer NOT NULL,
	`project_fk` integer NOT NULL,
	`video_id` text NOT NULL,
	`video_fk` integer,
	`url` text NOT NULL,
	`title` text,
	`channel` text,
	`duration_sec` integer,
	`published_at` text,
	`search_query` text,
	`source_type` text DEFAULT 'youtube' NOT NULL,
	`rank_score` real DEFAULT 0 NOT NULL,
	`caption_kind` text,
	`status` text DEFAULT 'metadata' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `find_sources_job_video_uq` ON `find_sources` (`job_fk`,`video_id`);--> statement-breakpoint
CREATE TABLE `moments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_fk` integer NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`start` real NOT NULL,
	`end` real,
	`excerpt` text,
	`color` text DEFAULT 'amber' NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_beats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_fk` integer NOT NULL,
	`revision_fk` integer NOT NULL,
	`ord` integer NOT NULL,
	`text` text NOT NULL,
	`entities` text,
	`aliases` text,
	`purpose` text,
	`coverage_types` text,
	`needs_transcript_search` integer DEFAULT true NOT NULL,
	`visual_only` integer DEFAULT false NOT NULL,
	`desired_clip_len_sec` real,
	`queries` text,
	`uncertainty` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`topic` text,
	`tags` text,
	`source_provider` text DEFAULT 'manual' NOT NULL,
	`source_doc_id` text,
	`source_title` text,
	`source_url` text,
	`source_modified_at` text,
	`status` text DEFAULT 'imported' NOT NULL,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`preroll_sec` real DEFAULT 3 NOT NULL,
	`postroll_sec` real DEFAULT 1.5 NOT NULL,
	`default_clip_len_sec` real DEFAULT 8 NOT NULL,
	`pipeline_log` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_fk` integer NOT NULL,
	`revision` integer NOT NULL,
	`script_text` text NOT NULL,
	`script_hash` text NOT NULL,
	`extracted_from_heading` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_search_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_fk` integer NOT NULL,
	`query` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_fk` integer NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	`start` real NOT NULL,
	`end` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_studio_exports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_fk` integer NOT NULL,
	`mode` text DEFAULT 'separate' NOT NULL,
	`title` text NOT NULL,
	`items` text NOT NULL,
	`output_dir` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`stage` text DEFAULT 'Queued' NOT NULL,
	`output_paths` text,
	`output_path` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transcript_studio_exports_video_status_idx` ON `transcript_studio_exports` (`video_fk`,`status`);--> statement-breakpoint
CREATE TABLE `transcript_studio_segment_edits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_fk` integer NOT NULL,
	`segment_idx` integer NOT NULL,
	`original_text` text NOT NULL,
	`display_text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_studio_segment_edits_video_segment_uq` ON `transcript_studio_segment_edits` (`video_fk`,`segment_idx`);--> statement-breakpoint
CREATE TABLE `transcript_studio_sessions` (
	`video_fk` integer PRIMARY KEY NOT NULL,
	`search_query` text DEFAULT '' NOT NULL,
	`in_point` real,
	`out_point` real,
	`clip_queue` text,
	`source_height` integer,
	`source_duration_sec` real,
	`transcript_cache_key` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`channel` text,
	`thumbnail` text,
	`duration_sec` integer,
	`transcript_lang` text,
	`transcript_kind` text DEFAULT 'none' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error_message` text,
	`favorite` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`project_id` integer,
	`last_position` real DEFAULT 0 NOT NULL,
	`last_opened_at` integer DEFAULT (unixepoch()) NOT NULL,
	`retrieved_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_video_id_unique` ON `videos` (`video_id`);