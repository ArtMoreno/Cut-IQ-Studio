import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLIPS_DIR } from "../runtimePaths";

export type CuratedSourceKind = "full_game" | "condensed_game" | "highlights";

export interface CuratedFindSource {
  videoId: string;
  url: string;
  title: string;
  opponent: string;
  kind: CuratedSourceKind;
  rankScore: number;
  sourceLabel: string;
  sourceType: "youtube" | "local";
  localPath: string | null;
}

type MiamiSource = Omit<CuratedFindSource, "url" | "rankScore" | "sourceLabel" | "sourceType" | "localPath"> & {
  aliases: string[];
  localPath?: string;
};

const TEXAS_AM_LOCAL_FULL_GAME = join(
  CLIPS_DIR,
  "Source Library",
  "Miami Hurricanes",
  "2025",
  "2025-12-20_Miami_vs_Texas_AM_CFP_First_Round_OKRU_720p60.mp4",
);

const MIAMI_2025_SOURCES: MiamiSource[] = [
  { videoId: "pH-45Dz3tzg", title: "Notre Dame vs. Miami Full Game Replay | 2025 ACC Football", opponent: "Notre Dame", aliases: ["Notre Dame"], kind: "full_game" },
  { videoId: "Lq8i9dS1fSk", title: "Bethune-Cookman vs. Miami Full Game Replay | 2025 ACC Football", opponent: "Bethune-Cookman", aliases: ["Bethune-Cookman", "Bethune Cookman"], kind: "full_game" },
  { videoId: "B8CYu4ARln0", title: "South Florida vs. Miami Full Game Replay | 2025 ACC Football", opponent: "South Florida", aliases: ["South Florida", "USF"], kind: "full_game" },
  { videoId: "2UVaoDvLBbA", title: "Florida vs. Miami Full Game Replay | 2025 ACC Football", opponent: "Florida", aliases: ["Florida", "Florida Gators"], kind: "full_game" },
  { videoId: "Akg8cbDfD-U", title: "Miami vs Florida State Full Game Replay | 2025 ACC Football", opponent: "Florida State", aliases: ["Florida State", "FSU"], kind: "full_game" },
  { videoId: "fdTpUEKmk3I", title: "Louisville vs. Miami Full Game Replay | 2025 ACC Football", opponent: "Louisville", aliases: ["Louisville"], kind: "full_game" },
  { videoId: "rHlRoTFPOoQ", title: "Stanford vs Miami Full Game Replay | 2025 ACC Football", opponent: "Stanford", aliases: ["Stanford"], kind: "full_game" },
  { videoId: "WZeSs6VdciM", title: "Miami vs SMU Full Game Replay | 2025 ACC Football", opponent: "SMU", aliases: ["SMU", "Southern Methodist"], kind: "full_game" },
  { videoId: "x8MlXBA45E0", title: "Syracuse vs #18 Miami | November 8, 2025 | NCAA Football Full Game Replay", opponent: "Syracuse", aliases: ["Syracuse"], kind: "full_game" },
  { videoId: "aZ0RmAF2ZbM", title: "Syracuse vs Miami Condensed Game | 2025 ACC Football", opponent: "Syracuse", aliases: ["Syracuse"], kind: "condensed_game" },
  { videoId: "OkDd13nP2jc", title: "NC State vs Miami Full Game Replay | 2025 ACC Football", opponent: "NC State", aliases: ["NC State", "North Carolina State"], kind: "full_game" },
  { videoId: "YCJe8MCKmVc", title: "Miami vs. Virginia Tech Full Game Replay | 2025 ACC Football", opponent: "Virginia Tech", aliases: ["Virginia Tech", "Virginia Tech Hokies"], kind: "full_game" },
  { videoId: "b0Rem9l3cGE", title: "Miami vs Pitt Full Game Replay | 2025 ACC Football", opponent: "Pittsburgh", aliases: ["Pittsburgh", "Pitt"], kind: "full_game" },
  { videoId: "Qd8v8hZsCJk", title: "CFP First Round: Miami Hurricanes vs. Texas A&M Aggies | Full Game Highlights | ESPN CFB", opponent: "Texas A&M", aliases: ["Texas A&M", "Texas AM"], kind: "highlights" },
  { videoId: "local-miami-tamu-2025-full", title: "Miami vs Texas A&M CFP First Round Full Game | Local 720p60 Archive", opponent: "Texas A&M", aliases: ["Texas A&M", "Texas AM"], kind: "full_game", localPath: TEXAS_AM_LOCAL_FULL_GAME },
  { videoId: "0Na59dbnOrA", title: "2025 CFP Quarterfinal | SKYCAST | Miami vs Ohio State | College Football Full Game", opponent: "Ohio State", aliases: ["Ohio State", "Ohio State Buckeyes"], kind: "full_game" },
  { videoId: "nQsOIn5h3rM", title: "Cotton Bowl: Miami Hurricanes vs. Ohio State Buckeyes | Full Game Highlights | ESPN College Football", opponent: "Ohio State", aliases: ["Ohio State", "Ohio State Buckeyes"], kind: "highlights" },
  { videoId: "5EB272y4Dxo", title: "2026 CFP Semifinal: Miami vs Ole Miss | Full Game Replay", opponent: "Ole Miss", aliases: ["Ole Miss", "Mississippi"], kind: "full_game" },
  { videoId: "7Twgco9Cu14", title: "Fiesta Bowl: Miami Hurricanes vs. Ole Miss Rebels | Full Game Highlights | ESPN College Football", opponent: "Ole Miss", aliases: ["Ole Miss", "Mississippi"], kind: "highlights" },
  { videoId: "UJqTHZg99Jo", title: "2026 CFP National Championship | Indiana vs Miami | Full Game Replay", opponent: "Indiana", aliases: ["Indiana", "Indiana Hoosiers"], kind: "full_game" },
  { videoId: "4KDE7NMshvI", title: "CFP National Championship: Miami Hurricanes vs. Indiana Hoosiers | Full Game Highlights | ESPN CFB", opponent: "Indiana", aliases: ["Indiana", "Indiana Hoosiers"], kind: "highlights" },
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMiamiHurricanes(team: string): boolean {
  const value = normalize(team);
  if (/\b(miami ohio|miami oh|redhawks)\b/.test(value)) return false;
  return value === "miami"
    || value.includes("miami hurricanes")
    || value.includes("university of miami")
    || value.includes("miami fl");
}

/**
 * Curated, user-supplied source portfolios are additive discovery seeds.
 * They never replace the normal YouTube search and only activate for the
 * matching team and season.
 */
export function curatedSourcesForFindJob(input: {
  team: string;
  season: number;
  games?: string[];
}): CuratedFindSource[] {
  if (input.season !== 2025 || !isMiamiHurricanes(input.team)) return [];
  const requestedGames = (input.games ?? []).map(normalize).filter(Boolean);
  const sources = (requestedGames.length
    ? MIAMI_2025_SOURCES.filter((source) => source.aliases.some((alias) => requestedGames.includes(normalize(alias))))
    : MIAMI_2025_SOURCES)
    .filter((source) => !source.localPath || existsSync(source.localPath));

  return sources.map((source) => ({
    videoId: source.videoId,
    url: source.localPath ? pathToFileURL(source.localPath).href : `https://www.youtube.com/watch?v=${source.videoId}`,
    title: source.title,
    opponent: source.opponent,
    kind: source.kind,
    rankScore: source.kind === "full_game" ? 1 : source.kind === "condensed_game" ? 0.94 : 0.82,
    sourceLabel: `Curated Miami 2025 replay guide — ${source.kind.replaceAll("_", " ")}`,
    sourceType: source.localPath ? "local" : "youtube",
    localPath: source.localPath ?? null,
  }));
}
