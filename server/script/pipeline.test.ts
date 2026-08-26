/**
 * Script/Project pipeline integration tests — real MariaDB via .env.
 * Fixtures use a unique run suffix and are deleted in afterAll so the user's
 * library and prior projects are never touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { clipCandidates, scriptBeats, scriptProjects, scriptRevisions } from "@db/schema";
import {
  defaultProjectName,
  getProjectStatus,
  runAnalyze,
  runDiscover,
  runRank,
  scriptHash,
  upsertScriptProject,
} from "./pipeline";

const RUN = Date.now().toString(36);
const DOC_ID = `test-doc-${RUN}`;
const PLAYER = "Marcus Webb"; // two-word name so entity extraction can find it
const TOPIC = `${PLAYER} ${RUN}`;

const SCRIPT_V1 = `${PLAYER} arrived at Miami as a matchup problem. Coaches planned to use him all over the formation.

"${PLAYER} is the kind of tight end you build a game plan around," said the head coach.

In the 2024 season he had 31 receptions for 412 yards and three touchdowns.`;

const SCRIPT_V2 = `${SCRIPT_V1}

The story continues into the transfer portal era.`;

const createdProjectIds: number[] = [];

function baseIngress(scriptText: string) {
  return {
    sourceProvider: "google_docs",
    sourceDocId: DOC_ID,
    sourceTitle: `Pipeline Test Doc ${RUN}`,
    sourceUrl: `https://docs.google.com/document/d/${DOC_ID}/edit`,
    sourceModifiedAt: "2026-08-07T12:00:00Z",
    scriptText,
    topic: TOPIC,
    extractedFromHeading: "Final Script",
  };
}

afterAll(async () => {
  const db = getDb();
  for (const id of createdProjectIds) {
    await db.delete(clipCandidates).where(eq(clipCandidates.projectFk, id));
    await db.delete(scriptBeats).where(eq(scriptBeats.projectFk, id));
    await db.delete(scriptRevisions).where(eq(scriptRevisions.projectFk, id));
    await db.delete(scriptProjects).where(eq(scriptProjects.id, id));
  }
});

describe("script ingress (requirement 2, 3, 4)", () => {
  it("creates one stable project from a programmatic submission", async () => {
    const res = await upsertScriptProject(baseIngress(SCRIPT_V1));
    createdProjectIds.push(res.projectId);
    expect(res.isNewProject).toBe(true);
    expect(res.revision).toBe(1);
    expect(res.status).toBe("imported");
    expect(res.name).toContain("JOB");
  });

  it("resubmitting the unchanged script does NOT duplicate the project", async () => {
    const res = await upsertScriptProject(baseIngress(SCRIPT_V1));
    expect(res.isNewProject).toBe(false);
    expect(res.isNewRevision).toBe(false);
    expect(res.projectId).toBe(createdProjectIds[0]);
    expect(res.revision).toBe(1);
  });

  it("a changed script creates revision 2 on the SAME project", async () => {
    const res = await upsertScriptProject(baseIngress(SCRIPT_V2));
    expect(res.isNewProject).toBe(false);
    expect(res.isNewRevision).toBe(true);
    expect(res.projectId).toBe(createdProjectIds[0]);
    expect(res.revision).toBe(2);
  });

  it("keeps independently identified Find Clips submissions isolated even with identical briefs", async () => {
    const first = await upsertScriptProject({
      ...baseIngress(SCRIPT_V1),
      sourceProvider: "find_clips",
      sourceDocId: `find-clips-a-${RUN}`,
    });
    const second = await upsertScriptProject({
      ...baseIngress(SCRIPT_V1),
      sourceProvider: "find_clips",
      sourceDocId: `find-clips-b-${RUN}`,
    });
    createdProjectIds.push(first.projectId, second.projectId);
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.isNewProject).toBe(true);
    expect(second.isNewProject).toBe(true);
  });

  it("script hash is stable and whitespace-normalized", () => {
    expect(scriptHash("abc")).toBe(scriptHash("abc"));
    expect(scriptHash("a\r\nb")).toBe(scriptHash("a\nb"));
    expect(scriptHash("a")).not.toBe(scriptHash("b"));
  });

  it("default naming follows YYYY-MM-DD__JOB__TOPIC", () => {
    const name = defaultProjectName("Elijah Lofton", undefined);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}__JOB__Elijah-Lofton$/);
    expect(defaultProjectName("x", "My Custom Name")).toBe("My Custom Name");
  });
});

describe("analyze stage (requirement 5)", () => {
  it("creates ordered beats with coverage needs", async () => {
    const projectId = createdProjectIds[0];
    const res = await runAnalyze(projectId);
    expect(res.beats).toBeGreaterThanOrEqual(3);
    const db = getDb();
    const [rev] = await db
      .select()
      .from(scriptRevisions)
      .where(eq(scriptRevisions.projectFk, projectId))
      .orderBy(desc(scriptRevisions.revision))
      .limit(1);
    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev!.id));
    const ords = beats.map((b) => b.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));
    expect(ords.length).toBe(new Set(ords).size);
    // entities were extracted for the named player
    const entities = beats.flatMap((b) => JSON.parse(b.entities ?? "[]") as string[]);
    expect(entities.some((e) => String(e).includes(PLAYER))).toBe(true);
    // quote beat exists (the coach quote)
    expect(beats.some((b) => b.purpose === "quote")).toBe(true);
  });

  it("preserves beat ids when an unchanged revision is analyzed again", async () => {
    const projectId = createdProjectIds[0];
    const db = getDb();
    const [rev] = await db
      .select()
      .from(scriptRevisions)
      .where(eq(scriptRevisions.projectFk, projectId))
      .orderBy(desc(scriptRevisions.revision))
      .limit(1);
    const before = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev!.id));
    await runAnalyze(projectId);
    const after = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev!.id));
    expect(after.map((beat) => beat.id).sort((a, b) => a - b)).toEqual(before.map((beat) => beat.id).sort((a, b) => a - b));
  });
});

describe("discover stage (requirement 6, 7, 8)", () => {
  it("returns normalized candidates and isolates provider failures", async () => {
    const projectId = createdProjectIds[0];
    const res = await runDiscover(projectId);
    // Even without a YouTube key and with an empty library match, social
    // discovery links are produced as honest manual_review candidates.
    expect(res.candidates).toBeGreaterThan(0);
    const db = getDb();
    const cands = await db.select().from(clipCandidates).where(eq(clipCandidates.projectFk, projectId));
    for (const c of cands) {
      expect(c.provider).toBeTruthy();
      expect(c.sourceUrl).toBeTruthy();
      expect(["exact_transcript", "strong_visual", "probable_visual", "broad_candidate", "manual_review"]).toContain(c.matchKind);
    }
    // The project log records per-provider outcomes; failures (if any) are listed.
    const status = await getProjectStatus(projectId);
    expect(Array.isArray(status.providerFailures)).toBe(true);
  });

  it("a failed provider does not erase successful provider results", async () => {
    const projectId = createdProjectIds[0];
    const db = getDb();
    const before = await db.select().from(clipCandidates).where(eq(clipCandidates.projectFk, projectId));
    const socialBefore = before.filter((c) => c.provider === "instagram").length;
    expect(socialBefore).toBeGreaterThan(0);

    // Rerun discovery restricted to a failing/unavailable provider only:
    // other providers' rows must remain untouched.
    await runDiscover(projectId, { onlyProviders: ["youtube"] });
    const after = await db.select().from(clipCandidates).where(eq(clipCandidates.projectFk, projectId));
    const socialAfter = after.filter((c) => c.provider === "instagram").length;
    expect(socialAfter).toBe(socialBefore);
  });
});

describe("rank stage + status (requirement 9)", () => {
  it("ranks candidates, suggests edit points, and reports honest status", async () => {
    const projectId = createdProjectIds[0];
    const res = await runRank(projectId);
    expect(res.ranked).toBeGreaterThan(0);
    const status = await getProjectStatus(projectId);
    expect(["ready_for_review", "partially_complete"]).toContain(status.status);
    expect(status.beats.total).toBeGreaterThanOrEqual(3);
    // status persists independently of any in-memory state (DB-backed)
    const again = await getProjectStatus(projectId);
    expect(again.status).toBe(status.status);
    expect(again.candidates.total).toBe(status.candidates.total);
  });
});
