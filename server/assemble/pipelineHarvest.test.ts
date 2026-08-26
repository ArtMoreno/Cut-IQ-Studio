import { describe, it, expect } from "vitest";
import {
  parseClipsToRender,
  gameFromCode,
  parseCsv,
  parseClipManifestCsv,
  parseBeatMapCsv,
  parseTimecode,
} from "./pipelineHarvest";

const SAMPLE = `# Best Fletcher power/explosive clips selected from 265 candidates
# Format: video_id | game_label | in_sec | out_sec | duration | description

# 1. ND: "comes Fletcher again, powering close to another first down" (3715s)
nd=pH-45Dz3tzg|3700|3745|"Fletcher powering close to first down + 9yd run"

# 2. ND: "Fletcher gets downhill" + mauling commentary (1313s)
nd2=pH-45Dz3tzg|1298|1340|"Fletcher gets downhill bouncing off tacklers"

# 5. Stanford: "Their big bruising back Mark Fletcher" (228s)
stan=rHlRoTFPOoQ|213|260|"Big bruising back Mark Fletcher intro"

garbage line without pipes
`;

describe("parseClipsToRender", () => {
  it("parses well-formed data lines and skips comments/garbage", () => {
    const rows = parseClipsToRender(SAMPLE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ code: "nd", videoId: "pH-45Dz3tzg", inSec: 3700, outSec: 3745 });
    expect(rows[0].game).toBe("ND");
    expect(rows[1].game).toBe("ND");
    expect(rows[2]).toMatchObject({ code: "stan", videoId: "rHlRoTFPOoQ", inSec: 213, outSec: 260 });
    expect(rows[2].game).toBe("Stanford");
  });

  it("rejects rows with inverted ranges", () => {
    const rows = parseClipsToRender("x=abcdefghijk|50|40|\"bad\"\n");
    expect(rows).toHaveLength(0);
  });
});

describe("gameFromCode", () => {
  it("maps codes to readable game names", () => {
    expect(gameFromCode("nd3")).toBe("Notre Dame");
    expect(gameFromCode("ind7")).toBe("Indiana");
    expect(gameFromCode("miss1")).toBe("Ole Miss");
    expect(gameFromCode("unknown99")).toBeNull();
  });
});

// Format B: 00_job/clip_manifest.csv (malachi-toney-yac-2025 style)

const MANIFEST_CSV = `clip_id,beat_id,source_url,source_title,source_video_id,source_resolution,in_tc,out_tc,player,team,season,opponent,linked_beat,identity_verified,action_verified,season_verified,quality_verified,local_path,upload_status,drive_file_id,size_bytes,rights_note
01_nd_td_toney,yac-nd,https://www.youtube.com/watch?v=pH-45Dz3tzg,Notre Dame vs Miami,ND-video36,1080p,00:58:40,00:59:35,Malachi Toney,Miami,2025,Notre Dame,yac-nd,true,true,true,true,D:/Clips/pipeline_jobs/malachi-toney-yac-2025/03_clips/best/01_nd_td_toney.mp4,pending,,,"ACC Digital Network broadcast"
07_lou_62yd_catch_and_run,yac-lou,https://www.youtube.com/watch?v=abc12345678,Louisville vs Miami,LOU-video1,1080p,01:10:00,01:11:02,Malachi Toney,Miami,2025,Louisville,yac-lou,true,true,true,true,D:/Clips/pipeline_jobs/malachi-toney-yac-2025/03_clips/best/07_lou_62yd_catch_and_run.mp4,uploaded,file123,9876543,"ACC Digital Network broadcast"
`;

describe("parseCsv", () => {
  it("handles BOM, quoted fields with commas, and CRLF", () => {
    const rows = parseCsv("\uFEFFa,b,c\r\n1,\"x,y\",3\r\n");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", "3"],
    ]);
  });
});

describe("parseClipManifestCsv", () => {
  it("parses the malachi-format manifest with full provenance", () => {
    const rows = parseClipManifestCsv(MANIFEST_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      clipId: "01_nd_td_toney",
      beatId: "yac-nd",
      sourceVideoId: "ND-video36",
      inTc: "00:58:40",
      outTc: "00:59:35",
      player: "Malachi Toney",
      opponent: "Notre Dame",
      identityVerified: true,
      actionVerified: true,
    });
    expect(rows[1].localPath).toContain("07_lou_62yd_catch_and_run.mp4");
    expect(rows[1].opponent).toBe("Louisville");
  });
});

const BEAT_MAP_CSV = `beat_id,order,script_line,required,action,player,team,season,opponent,search_aliases,preferred_source,selected_clip_ids,coverage
yac-nd,1,"Notre Dame - Malachi Toney YAC/elusive moments",yes,yac_review,"Malachi Toney",Miami,2025,Notre Dame,"Malachi Toney,Toney,YAC,yards after catch,broke tackle,elusive",nd2025,,
yac-lou,7,"Louisville - Malachi Toney YAC/elusive moments",no,yac_review,"Malachi Toney",Miami,2025,Louisville,"Toney,YAC,broken tackle",lou2025,,
`;

describe("parseBeatMapCsv", () => {
  it("parses beat rows with script lines and aliases", () => {
    const rows = parseBeatMapCsv(BEAT_MAP_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ beatId: "yac-nd", order: 1, opponent: "Notre Dame" });
    expect(rows[0].scriptLine).toContain("YAC/elusive");
    expect(rows[0].aliases).toContain("yards after catch");
    expect(rows[0].aliases).toContain("broke tackle");
  });
});

describe("parseTimecode", () => {
  it("parses HH:MM:SS, MM:SS, and plain seconds", () => {
    expect(parseTimecode("00:58:40")).toBe(3520);
    expect(parseTimecode("38:11")).toBe(2291);
    expect(parseTimecode("123.5")).toBe(123.5);
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("garbage")).toBeNull();
  });
});
