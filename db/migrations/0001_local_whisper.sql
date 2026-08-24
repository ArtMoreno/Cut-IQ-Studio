-- Custom SQL migration file, put your code below! --
-- Persist the local fallback source distinctly from YouTube auto-captions so
-- reopened Transcript Studio sessions can disclose it accurately.
ALTER TABLE `videos`
  MODIFY COLUMN `transcript_kind` enum('manual','auto','local-whisper','imported','none') NOT NULL DEFAULT 'none';
