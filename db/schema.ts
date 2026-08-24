import {
  mysqlTable,
  mysqlEnum,
  varchar,
  text,
  timestamp,
  bigint,
  int,
  double,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const projects = mysqlTable("projects", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const videos = mysqlTable("videos", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  videoId: varchar("video_id", { length: 32 }).notNull().unique(),
  url: text("url").notNull(),
  title: varchar("title", { length: 512 }),
  channel: varchar("channel", { length: 255 }),
  thumbnail: text("thumbnail"),
  durationSec: int("duration_sec"),
  transcriptLang: varchar("transcript_lang", { length: 32 }),
  transcriptKind: mysqlEnum("transcript_kind", [
    "manual",
    "auto",
    "local-whisper",
    "imported",
    "none",
  ])
    .notNull()
    .default("none"),
  status: mysqlEnum("status", ["ok", "no_transcript", "error"])
    .notNull()
    .default("ok"),
  errorMessage: text("error_message"),
  favorite: boolean("favorite").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  projectId: bigint("project_id", { mode: "number", unsigned: true }),
  lastPosition: double("last_position").notNull().default(0),
  lastOpenedAt: timestamp("last_opened_at").notNull().defaultNow(),
  retrievedAt: timestamp("retrieved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const transcriptSegments = mysqlTable("transcript_segments", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }).notNull(),
  idx: int("idx").notNull(),
  text: text("text").notNull(),
  start: double("start").notNull(),
  end: double("end").notNull(),
});

/**
 * Transcript Studio is additive to the established segment store. The session
 * retains user workspace state without mutating source captions, while edits
 * preserve an immutable original transcript alongside the display text.
 */
export const transcriptStudioSessions = mysqlTable("transcript_studio_sessions", {
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }).primaryKey(),
  searchQuery: varchar("search_query", { length: 512 }).notNull().default(""),
  inPoint: double("in_point"),
  outPoint: double("out_point"),
  clipQueue: text("clip_queue"), // JSON: locally staged clips and linked render jobs
  sourceHeight: int("source_height"),
  sourceDurationSec: double("source_duration_sec"),
  transcriptCacheKey: varchar("transcript_cache_key", { length: 200 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const transcriptStudioSegmentEdits = mysqlTable(
  "transcript_studio_segment_edits",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    videoFk: bigint("video_fk", { mode: "number", unsigned: true }).notNull(),
    segmentIdx: int("segment_idx").notNull(),
    originalText: text("original_text").notNull(),
    displayText: text("display_text").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [uniqueIndex("transcript_studio_segment_edits_video_segment_uq").on(table.videoFk, table.segmentIdx)],
);

/**
 * Manual Clip Studio exports have their own durable queue.  They deliberately
 * do not use clip_jobs, moments, candidates, script beats, or Find Clips rows;
 * this keeps a quick manual edit from changing automated pipeline state.
 */
export const transcriptStudioExports = mysqlTable(
  "transcript_studio_exports",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    videoFk: bigint("video_fk", { mode: "number", unsigned: true }).notNull(),
    mode: mysqlEnum("mode", ["separate", "joined"]).notNull().default("separate"),
    title: varchar("title", { length: 512 }).notNull(),
    items: text("items").notNull(), // ordered JSON: [{draftId,label,inPoint,outPoint}]
    outputDir: text("output_dir").notNull(), // canonical absolute Windows directory
    status: mysqlEnum("status", ["queued", "preparing", "rendering", "joining", "ready", "failed", "cancelled"])
      .notNull()
      .default("queued"),
    progress: double("progress").notNull().default(0),
    stage: varchar("stage", { length: 255 }).notNull().default("Queued"),
    outputPaths: text("output_paths"), // ordered JSON array for separate exports
    outputPath: text("output_path"), // joined output, or the sole separate output
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("transcript_studio_exports_video_status_idx").on(table.videoFk, table.status)],
);

/**
 * A narrow, reversible bridge from a finished Clip Package asset into Manual
 * Clip Studio.  Find Clips remains the owner of candidates and clip jobs;
 * these rows only snapshot the original lineage and point at a separately
 * rendered Studio export.
 */
export const clipPackageEditVersions = mysqlTable(
  "clip_package_edit_versions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
    candidateFk: bigint("candidate_fk", { mode: "number", unsigned: true }).notNull(),
    sourceVideoFk: bigint("source_video_fk", { mode: "number", unsigned: true }).notNull(),
    sourceClipJobFk: bigint("source_clip_job_fk", { mode: "number", unsigned: true }).notNull(),
    studioExportFk: bigint("studio_export_fk", { mode: "number", unsigned: true }),
    studioDraftId: varchar("studio_draft_id", { length: 120 }),
    intent: mysqlEnum("intent", ["new_version", "replacement"]).notNull().default("new_version"),
    status: mysqlEnum("status", ["draft", "exporting", "ready", "failed", "retired"])
      .notNull()
      .default("draft"),
    activeReplacement: boolean("active_replacement").notNull().default(false),
    originalIn: double("original_in").notNull(),
    originalOut: double("original_out").notNull(),
    editIn: double("edit_in").notNull(),
    editOut: double("edit_out").notNull(),
    drivePath: text("drive_path"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index("clip_package_edit_versions_project_candidate_idx").on(table.projectFk, table.candidateFk),
    index("clip_package_edit_versions_studio_export_idx").on(table.studioExportFk),
    index("clip_package_edit_versions_active_idx").on(table.projectFk, table.candidateFk, table.activeReplacement),
  ],
);

export const moments = mysqlTable("moments", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }).notNull(),
  title: varchar("title", { length: 512 }).notNull(),
  note: text("note"),
  start: double("start").notNull(),
  end: double("end"),
  excerpt: text("excerpt"),
  color: varchar("color", { length: 32 }).notNull().default("amber"),
  status: mysqlEnum("status", ["candidate", "selected", "used"])
    .notNull()
    .default("candidate"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const searchHistory = mysqlTable("search_history", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }).notNull(),
  query: varchar("query", { length: 512 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ══════════════════════════════════════════════════════════════════
// Script / Project mode (CSC script → clip map). Additive only —
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

export const scriptProjects = mysqlTable("script_projects", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  topic: varchar("topic", { length: 255 }),
  tags: text("tags"), // JSON array
  sourceProvider: varchar("source_provider", { length: 40 }).notNull().default("manual"),
  sourceDocId: varchar("source_doc_id", { length: 128 }), // stable identity (Google Doc ID)
  sourceTitle: varchar("source_title", { length: 512 }),
  sourceUrl: text("source_url"),
  sourceModifiedAt: varchar("source_modified_at", { length: 64 }),
  status: mysqlEnum("status", SCRIPT_PROJECT_STATUSES).notNull().default("imported"),
  currentRevision: int("current_revision").notNull().default(1),
  prerollSec: double("preroll_sec").notNull().default(3),
  postrollSec: double("postroll_sec").notNull().default(1.5),
  defaultClipLenSec: double("default_clip_len_sec").notNull().default(8),
  pipelineLog: text("pipeline_log"), // JSON array of {at, stage, provider?, ok, message?}
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const scriptRevisions = mysqlTable("script_revisions", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
  revision: int("revision").notNull(),
  scriptText: text("script_text").notNull(),
  scriptHash: varchar("script_hash", { length: 64 }).notNull(),
  extractedFromHeading: varchar("extracted_from_heading", { length: 200 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const scriptBeats = mysqlTable("script_beats", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
  revisionFk: bigint("revision_fk", { mode: "number", unsigned: true }).notNull(),
  ord: int("ord").notNull(),
  text: text("text").notNull(),
  entities: text("entities"), // JSON
  aliases: text("aliases"), // JSON
  purpose: varchar("purpose", { length: 40 }),
  coverageTypes: text("coverage_types"), // JSON array
  needsTranscriptSearch: boolean("needs_transcript_search").notNull().default(true),
  visualOnly: boolean("visual_only").notNull().default(false),
  desiredClipLenSec: double("desired_clip_len_sec"),
  queries: text("queries"), // JSON array (budgeted)
  uncertainty: text("uncertainty"),
  status: mysqlEnum("status", ["pending", "covered", "needs_footage"]).notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const CANDIDATE_STATES = ["undecided", "approved", "rejected"] as const;
export const MATCH_KINDS = [
  "exact_transcript",
  "strong_visual",
  "probable_visual",
  "broad_candidate",
  "manual_review",
] as const;

export const clipCandidates = mysqlTable("clip_candidates", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
  revisionFk: bigint("revision_fk", { mode: "number", unsigned: true }).notNull(),
  beatFk: bigint("beat_fk", { mode: "number", unsigned: true }).notNull(),
  provider: varchar("provider", { length: 40 }).notNull(),
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }), // set when backed by a library video
  sourceUrl: text("source_url").notNull(),
  sourceAccount: varchar("source_account", { length: 300 }),
  title: varchar("title", { length: 512 }),
  publishedAt: varchar("published_at", { length: 64 }),
  durationSec: double("duration_sec"),
  thumbnailUrl: text("thumbnail_url"),
  matchKind: mysqlEnum("match_kind", MATCH_KINDS).notNull().default("manual_review"),
  transcriptExcerpt: text("transcript_excerpt"),
  segStart: double("seg_start"), // source timestamp (seconds)
  segEnd: double("seg_end"),
  editIn: double("edit_in"), // suggested edit range (seconds)
  editOut: double("edit_out"),
  relevanceScore: double("relevance_score").notNull().default(0),
  qualityScore: double("quality_score").notNull().default(0),
  cleanSourceScore: double("clean_source_score").notNull().default(0),
  visualConfidence: double("visual_confidence").notNull().default(0),
  reason: text("reason"),
  acquisitionStatus: varchar("acquisition_status", { length: 60 }).notNull().default("metadata_only"),
  dupGroupKey: varchar("dup_group_key", { length: 80 }),
  state: mysqlEnum("state", CANDIDATE_STATES).notNull().default("undecided"),
  userNotes: text("user_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const scriptSearchCache = mysqlTable("script_search_cache", {
  cacheKey: varchar("cache_key", { length: 200 }).primaryKey(),
  payload: text("payload").notNull(), // JSON
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

// Durable Find Clips orchestration. The established script project, beat,
// candidate, video, transcript and clip-job tables remain the canonical media
// model; these rows only own queue/recovery state and source provenance.
export const findJobs = mysqlTable(
  "find_jobs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
    player: varchar("player", { length: 255 }).notNull(),
    team: varchar("team", { length: 255 }).notNull(),
    season: int("season").notNull(),
    opponent: varchar("opponent", { length: 255 }),
    sourceLimit: int("source_limit").notNull().default(20),
    clipLimit: int("clip_limit").notNull().default(30),
    preferredHeight: int("preferred_height").notNull().default(1080),
    minimumHeight: int("minimum_height").notNull().default(720),
    preRollSec: double("pre_roll_sec").notNull().default(10),
    postRollSec: double("post_roll_sec").notNull().default(15),
    localAsrFallback: boolean("local_asr_fallback").notNull().default(true),
    highlightTunerSettings: text("highlight_tuner_settings"), // nullable JSON; null preserves legacy Everything behavior
    status: varchar("status", { length: 48 }).notNull().default("queued"),
    stage: varchar("stage", { length: 80 }).notNull().default("queued"),
    progressPercent: double("progress_percent").notNull().default(0),
    currentOperation: text("current_operation"),
    pauseRequested: boolean("pause_requested").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    retryCount: int("retry_count").notNull().default(0),
    maxRetries: int("max_retries").notNull().default(3),
    sourcesFound: int("sources_found").notNull().default(0),
    transcriptsFound: int("transcripts_found").notNull().default(0),
    candidatesFound: int("candidates_found").notNull().default(0),
    clipsQueued: int("clips_queued").notNull().default(0),
    clipsVerified: int("clips_verified").notNull().default(0),
    warnings: text("warnings"), // JSON string[]
    lastError: text("last_error"),
    lastProgressAt: timestamp("last_progress_at").notNull().defaultNow(),
    workerHeartbeatAt: timestamp("worker_heartbeat_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [uniqueIndex("find_jobs_project_uq").on(table.projectFk)],
);

export const findSources = mysqlTable(
  "find_sources",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    jobFk: bigint("job_fk", { mode: "number", unsigned: true }).notNull(),
    projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
    videoId: varchar("video_id", { length: 32 }).notNull(),
    videoFk: bigint("video_fk", { mode: "number", unsigned: true }),
    url: text("url").notNull(),
    title: varchar("title", { length: 512 }),
    channel: varchar("channel", { length: 255 }),
    durationSec: int("duration_sec"),
    publishedAt: varchar("published_at", { length: 64 }),
    searchQuery: varchar("search_query", { length: 512 }),
    sourceType: varchar("source_type", { length: 64 }).notNull().default("youtube"),
    rankScore: double("rank_score").notNull().default(0),
    captionKind: varchar("caption_kind", { length: 32 }),
    status: varchar("status", { length: 48 }).notNull().default("metadata"),
    attemptCount: int("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
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

export const assembleProjects = mysqlTable("assemble_projects", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  sourceProjectFk: bigint("source_project_fk", { mode: "number", unsigned: true }), // optional link to script_projects
  sourceCscSlug: varchar("source_csc_slug", { length: 255 }), // optional link to a CSC job folder under D:\Clips\csc_jobs
  doc: text("doc").notNull(), // JSON: AssembleDoc (schemaVersion, beats, items, settings, narration)
  preset: varchar("preset", { length: 32 }).notNull().default("csc-vertical"),
  status: varchar("status", { length: 40 }).notNull().default("draft"), // draft | assembled | rendering | rendered | failed
  renderLog: text("render_log"), // JSON array of {at, ok, message}
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const assembleAutosaves = mysqlTable("assemble_autosaves", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  projectFk: bigint("project_fk", { mode: "number", unsigned: true }).notNull(),
  doc: text("doc").notNull(), // JSON snapshot of AssembleDoc at save time
  reason: varchar("reason", { length: 60 }).notNull().default("autosave"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const clipJobs = mysqlTable("clip_jobs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["candidate", "moment"]).notNull(),
  projectFk: bigint("project_fk", { mode: "number", unsigned: true }), // script project (candidate jobs)
  candidateFk: bigint("candidate_fk", { mode: "number", unsigned: true }), // script candidate
  momentFk: bigint("moment_fk", { mode: "number", unsigned: true }), // single-video moment
  videoFk: bigint("video_fk", { mode: "number", unsigned: true }), // library video row
  sourceUrl: text("source_url").notNull(), // YouTube watch URL
  title: varchar("title", { length: 512 }).notNull(), // clip display name
  fileName: varchar("file_name", { length: 512 }), // output filename when ready
  editIn: double("edit_in").notNull(),
  editOut: double("edit_out").notNull(),
  height: int("height").notNull().default(720), // requested output height (0 = best)
  minimumHeight: int("minimum_height").notNull().default(720), // verification floor
  uploadToDrive: boolean("upload_to_drive").notNull().default(false),
  status: mysqlEnum("status", CLIP_JOB_STATUSES).notNull().default("queued"),
  progress: double("progress").notNull().default(0), // 0..100
  stage: varchar("stage", { length: 200 }).notNull().default("queued"),
  outputPath: text("output_path"), // absolute path to finished mp4
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  outputWidth: int("output_width"),
  outputHeight: int("output_height"),
  outputDurationSec: double("output_duration_sec"),
  outputHasAudio: boolean("output_has_audio"),
  drivePath: text("drive_path"), // gdrive:ClipSift/<project>/<file> when uploaded
  error: text("error"),
  diagnosticError: text("diagnostic_error"), // sanitized tool/client failure detail for Diagnostics
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});
