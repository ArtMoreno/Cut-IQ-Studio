-- Assemble is intentionally additive. These clauses are idempotent so a local
-- install that already received the schema through the desktop maintenance
-- workflow can re-run them safely.
CREATE TABLE IF NOT EXISTS `assemble_projects` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `source_project_fk` bigint unsigned,
  `doc` text NOT NULL,
  `preset` varchar(32) NOT NULL DEFAULT 'csc-vertical',
  `status` varchar(40) NOT NULL DEFAULT 'draft',
  `render_log` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assemble_autosaves` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `project_fk` bigint unsigned NOT NULL,
  `doc` text NOT NULL,
  `reason` varchar(60) NOT NULL DEFAULT 'autosave',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);
