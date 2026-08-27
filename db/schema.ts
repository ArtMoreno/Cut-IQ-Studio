import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const videos = sqliteTable("videos", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  videoId: text("video_id").notNull().unique(),
  url: text("url").notNull(),
  title: text("title"),
  channel: text("channel"),
  thumbnail: text("thumbnail"),
  durationSec: integer("duration_sec"),
  transcriptLang: text("transcript_lang"),
  transcriptKind: text("transcript_kind", { enum: [
    "manual",
    "auto",
    "local-whisper",
    "imported",
    "none",
  ] })
    .notNull()
    .default("none"),
  status: text("status", { enum: ["ok", "no_transcript", "error"] })
    .notNull()
    .default("ok"),
  errorMessage: text("error_message"),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  projectId: integer("project_id", { mode: "number" }),
  lastPosition: real("last_position").notNull().default(0),
  lastOpenedAt: integer("last_opened_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  retrievedAt: integer("retrieved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const transcriptSegments = sqliteTable("transcript_segments", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  videoFk: integer("video_fk", { mode: "number" }).notNull(),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  start: real("start").notNull(),
  end: real("end").notNull(),
});

/**
 * Transcript Studio is additive to the established segment store. The session
 * retains user workspace state without mutating source captions, while edits
 * preserve an immutable original transcript alongside the display text.
 */
export const transcriptStudioSessions = sqliteTable("transcript_studio_sessions", {
  videoFk: integer("video_fk", { mode: "number" }).primaryKey(),
  searchQuery: text("search_query").notNull().default(""),
  inPoint: real("in_point"),
  outPoint: real("out_point"),
  clipQueue: text("clip_queue"), // JSON: locally staged clips and linked render jobs
  sourceHeight: integer("source_height"),
  sourceDurationSec: real("source_duration_sec"),
  transcriptCacheKey: text("transcript_cache_key"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
});

export const transcriptStudioSegmentEdits = sqliteTable(
  "transcript_studio_segment_edits",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    videoFk: integer("video_fk", { mode: "number" }).notNull(),
    segmentIdx: integer("segment_idx").notNull(),
    originalText: text("original_text").notNull(),
    displayText: text("display_text").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("transcript_studio_segment_edits_video_segment_uq").on(table.videoFk, table.segmentIdx)],
);

/**
 * Manual Clip Studio exports have their own durable queue.  They deliberately
 * do not use clip_jobs, moments, candidates, script beats, or Find Clips rows;
 * this keeps a quick manual edit from changing automated pipeline state.
 */
export const transcriptStudioExports = sqliteTable(
  "transcript_studio_exports",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    videoFk: integer("video_fk", { mode: "number" }).notNull(),
    mode: text("mode", { enum: ["separate", "joined"] }).notNull().default("separate"),
    title: text("title").notNull(),
    items: text("items").notNull(), // ordered JSON: [{draftId,label,inPoint,outPoint}]
    outputDir: text("output_dir").notNull(), // canonical absolute Windows directory
    status: text("status", { enum: ["queued", "preparing", "rendering", "joining", "ready", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    progress: real("progress").notNull().default(0),
    stage: text("stage").notNull().default("Queued"),
    outputPaths: text("output_paths"), // ordered JSON array for separate exports
    outputPath: text("output_path"), // joined output, or the sole separate output
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
  },
  (table) => [index("transcript_studio_exports_video_status_idx").on(table.videoFk, table.status)],
);

/**
 * A narrow, reversible bridge from a finished Clip Package asset into Manual
 * Clip Studio.  Find Clips remains the owner of candidates and clip jobs;
 * these rows only snapshot the original lineage and point at a separately
 * rendered Studio export.
 */
export const clipPackageEditVersions = sqliteTable(
  "clip_package_edit_versions",
  {
    id: text("id").primaryKey(),
    projectFk: integer("project_fk", { mode: "number" }).notNull(),
    candidateFk: integer("candidate_fk", { mode: "number" }).notNull(),
    sourceVideoFk: integer("source_video_fk", { mode: "number" }).notNull(),
    sourceClipJobFk: integer("source_clip_job_fk", { mode: "number" }).notNull(),
    studioExportFk: integer("studio_export_fk", { mode: "number" }),
    studioDraftId: text("studio_draft_id"),
    intent: text("intent", { enum: ["new_version", "replacement"] }).notNull().default("new_version"),
    status: text("status", { enum: ["draft", "exporting", "ready", "failed", "retired"] })
      .notNull()
      .default("draft"),
    activeReplacement: integer("active_replacement", { mode: "boolean" }).notNull().default(false),
    originalIn: real("original_in").notNull(),
    originalOut: real("original_out").notNull(),
    editIn: real("edit_in").notNull(),
    editOut: real("edit_out").notNull(),
    drivePath: text("drive_path"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
  },
  (table) => [
    index("clip_package_edit_versions_project_candidate_idx").on(table.projectFk, table.candidateFk),
    index("clip_package_edit_versions_studio_export_idx").on(table.studioExportFk),
    index("clip_package_edit_versions_active_idx").on(table.projectFk, table.candidateFk, table.activeReplacement),
  ],
);

export const moments = sqliteTable("moments", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  videoFk: integer("video_fk", { mode: "number" }).notNull(),
  title: text("title").notNull(),
  note: text("note"),
  start: real("start").notNull(),
  end: real("end"),
  excerpt: text("excerpt"),
  color: text("color").notNull().default("amber"),
  status: text("status", { enum: ["candidate", "selected", "used"] })
    .notNull()
    .default("candidate"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const searchHistory = sqliteTable("search_history", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  videoFk: integer("video_fk", { mode: "number" }).notNull(),
  query: text("query").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ══════════════════════════════════════════════════════════════════
// Script / Project mode (pipeline script → clip map). Additive only —
// the Single Video tables above are unchanged.
// ══════════════════════════════════════════════════════════════════

export const SCRIPT_PROJECT_STATUSES = [
  "imported",
  "analyzing",
  "building_coverage",
  "searching_sources",
  "fetching_transcripts",
  "ranking_candidates",
  "ready_for_review",
  "partially_complete",
  "failed",
] as const;

export const scriptProjects = sqliteTable("script_projects", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  topic: text("topic"),
  tags: text("tags"), // JSON array
  sourceProvider: text("source_provider").notNull().default("manual"),
  sourceDocId: text("source_doc_id"), // stable identity (Google Doc ID)
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),
  sourceModifiedAt: text("source_modified_at"),
  status: text("status", { enum: SCRIPT_PROJECT_STATUSES }).notNull().default("imported"),
  currentRevision: integer("current_revision").notNull().default(1),
  prerollSec: real("preroll_sec").notNull().default(3),
  postrollSec: real("postroll_sec").notNull().default(1.5),
  defaultClipLenSec: real("default_clip_len_sec").notNull().default(8),
  pipelineLog: text("pipeline_log"), // JSON array of {at, stage, provider?, ok, message?}
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
});

export const scriptRevisions = sqliteTable("script_revisions", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  projectFk: integer("project_fk", { mode: "number" }).notNull(),
  revision: integer("revision").notNull(),
  scriptText: text("script_text").notNull(),
  scriptHash: text("script_hash").notNull(),
  extractedFromHeading: text("extracted_from_heading"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const scriptBeats = sqliteTable("script_beats", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  projectFk: integer("project_fk", { mode: "number" }).notNull(),
  revisionFk: integer("revision_fk", { mode: "number" }).notNull(),
  ord: integer("ord").notNull(),
  text: text("text").notNull(),
  entities: text("entities"), // JSON
  aliases: text("aliases"), // JSON
  purpose: text("purpose"),
  coverageTypes: text("coverage_types"), // JSON array
  needsTranscriptSearch: integer("needs_transcript_search", { mode: "boolean" }).notNull().default(true),
  visualOnly: integer("visual_only", { mode: "boolean" }).notNull().default(false),
  desiredClipLenSec: real("desired_clip_len_sec"),
  queries: text("queries"), // JSON array (budgeted)
  uncertainty: text("uncertainty"),
  status: text("status", { enum: ["pending", "covered", "needs_footage"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const CANDIDATE_STATES = ["undecided", "approved", "rejected"] as const;
export const MATCH_KINDS = [
  "exact_transcript",
  "strong_visual",
  "probable_visual",
  "broad_candidate",
  "manual_review",
] as const;

export const clipCandidates = sqliteTable("clip_candidates", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  projectFk: integer("project_fk", { mode: "number" }).notNull(),
  revisionFk: integer("revision_fk", { mode: "number" }).notNull(),
  beatFk: integer("beat_fk", { mode: "number" }).notNull(),
  provider: text("provider").notNull(),
  videoFk: integer("video_fk", { mode: "number" }), // set when backed by a library video
  sourceUrl: text("source_url").notNull(),
  sourceAccount: text("source_account"),
  title: text("title"),
  publishedAt: text("published_at"),
  durationSec: real("duration_sec"),
  thumbnailUrl: text("thumbnail_url"),
  matchKind: text("match_kind", { enum: MATCH_KINDS }).notNull().default("manual_review"),
  transcriptExcerpt: text("transcript_excerpt"),
  segStart: real("seg_start"), // source timestamp (seconds)
  segEnd: real("seg_end"),
  editIn: real("edit_in"), // suggested edit range (seconds)
  editOut: real("edit_out"),
  relevanceScore: real("relevance_score").notNull().default(0),
  qualityScore: real("quality_score").notNull().default(0),
  cleanSourceScore: real("clean_source_score").notNull().default(0),
  visualConfidence: real("visual_confidence").notNull().default(0),
  reason: text("reason"),
  acquisitionStatus: text("acquisition_status").notNull().default("metadata_only"),
  dupGroupKey: text("dup_group_key"),
  state: text("state", { enum: CANDIDATE_STATES }).notNull().default("undecided"),
  userNotes: text("user_notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
});

export const scriptSearchCache = sqliteTable("script_search_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: text("payload").notNull(), // JSON
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
});

// Durable Find Clips orchestration. The established script project, beat,
// candidate, video, transcript and clip-job tables remain the canonical media
// model; these rows only own queue/recovery state and source provenance.
export const findJobs = sqliteTable(
  "find_jobs",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    projectFk: integer("project_fk", { mode: "number" }).notNull(),
    player: text("player").notNull(),
    team: text("team").notNull(),
    season: integer("season").notNull(),
    opponent: text("opponent"),
    sourceLimit: integer("source_limit").notNull().default(20),
    clipLimit: integer("clip_limit").notNull().default(30),
    preferredHeight: integer("preferred_height").notNull().default(1080),
    minimumHeight: integer("minimum_height").notNull().default(720),
    preRollSec: real("pre_roll_sec").notNull().default(10),
    postRollSec: real("post_roll_sec").notNull().default(15),
    localAsrFallback: integer("local_asr_fallback", { mode: "boolean" }).notNull().default(true),
    highlightTunerSettings: text("highlight_tuner_settings"), // nullable JSON; null preserves legacy Everything behavior
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progressPercent: real("progress_percent").notNull().default(0),
    currentOperation: text("current_operation"),
    pauseRequested: integer("pause_requested", { mode: "boolean" }).notNull().default(false),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    sourcesFound: integer("sources_found").notNull().default(0),
    transcriptsFound: integer("transcripts_found").notNull().default(0),
    candidatesFound: integer("candidates_found").notNull().default(0),
    clipsQueued: integer("clips_queued").notNull().default(0),
    clipsVerified: integer("clips_verified").notNull().default(0),
    warnings: text("warnings"), // JSON string[]
    lastError: text("last_error"),
    lastProgressAt: integer("last_progress_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    workerHeartbeatAt: integer("worker_heartbeat_at", { mode: "timestamp" }),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("find_jobs_project_uq").on(table.projectFk)],
);

export const findSources = sqliteTable(
  "find_sources",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    jobFk: integer("job_fk", { mode: "number" }).notNull(),
    projectFk: integer("project_fk", { mode: "number" }).notNull(),
    videoId: text("video_id").notNull(),
    videoFk: integer("video_fk", { mode: "number" }),
    url: text("url").notNull(),
    title: text("title"),
    channel: text("channel"),
    durationSec: integer("duration_sec"),
    publishedAt: text("published_at"),
    searchQuery: text("search_query"),
    sourceType: text("source_type").notNull().default("youtube"),
    rankScore: real("rank_score").notNull().default(0),
    captionKind: text("caption_kind"),
    status: text("status").notNull().default("metadata"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("find_sources_job_video_uq").on(table.jobFk, table.videoId)],
);

// ══════════════════════════════════════════════════════════════════
// Clip rendering jobs (yt-dlp section cut → D:\Clips → optional Drive)
// ══════════════════════════════════════════════════════════════════

export const CLIP_JOB_STATUSES = [
  "queued", // waiting for the render worker
  "downloading", // yt-dlp section download + cut in progress
  "uploading", // rclone copy to Google Drive in progress
  "ready", // mp4 on disk (and Drive if requested)
  "failed", // error (see error column)
  "cancelled", // user cancelled while queued
] as const;

// ══════════════════════════════════════════════════════════════════
// Assemble — script/voiceover → editable timeline → render. Additive only.
// The canonical edit is a versioned JSON doc (the `doc` column); autosaves
// hold recoverable history snapshots.
// ══════════════════════════════════════════════════════════════════

export const assembleProjects = sqliteTable("assemble_projects", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sourceProjectFk: integer("source_project_fk", { mode: "number" }), // optional link to script_projects
  sourceJobSlug: text("source_job_slug"), // optional link to a pipeline job folder under the clips directory
  doc: text("doc").notNull(), // JSON: AssembleDoc (schemaVersion, beats, items, settings, narration)
  preset: text("preset").notNull().default("vertical-9x16"),
  status: text("status").notNull().default("draft"), // draft | assembled | rendering | rendered | failed
  renderLog: text("render_log"), // JSON array of {at, ok, message}
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
});

export const assembleAutosaves = sqliteTable("assemble_autosaves", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  projectFk: integer("project_fk", { mode: "number" }).notNull(),
  doc: text("doc").notNull(), // JSON snapshot of AssembleDoc at save time
  reason: text("reason").notNull().default("autosave"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const clipJobs = sqliteTable("clip_jobs", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["candidate", "moment"] }).notNull(),
  projectFk: integer("project_fk", { mode: "number" }), // script project (candidate jobs)
  candidateFk: integer("candidate_fk", { mode: "number" }), // script candidate
  momentFk: integer("moment_fk", { mode: "number" }), // single-video moment
  videoFk: integer("video_fk", { mode: "number" }), // library video row
  sourceUrl: text("source_url").notNull(), // YouTube watch URL
  title: text("title").notNull(), // clip display name
  fileName: text("file_name"), // output filename when ready
  editIn: real("edit_in").notNull(),
  editOut: real("edit_out").notNull(),
  height: integer("height").notNull().default(720), // requested output height (0 = best)
  minimumHeight: integer("minimum_height").notNull().default(720), // verification floor
  uploadToDrive: integer("upload_to_drive", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: CLIP_JOB_STATUSES }).notNull().default("queued"),
  progress: real("progress").notNull().default(0), // 0..100
  stage: text("stage").notNull().default("queued"),
  outputPath: text("output_path"), // absolute path to finished mp4
  fileSizeBytes: integer("file_size_bytes", { mode: "number" }),
  outputWidth: integer("output_width"),
  outputHeight: integer("output_height"),
  outputDurationSec: real("output_duration_sec"),
  outputHasAudio: integer("output_has_audio", { mode: "boolean" }),
  drivePath: text("drive_path"), // gdrive:ClipSift/<project>/<file> when uploaded
  error: text("error"),
  diagnosticError: text("diagnostic_error"), // sanitized tool/client failure detail for Diagnostics
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`).$onUpdate(() => new Date()),
});
