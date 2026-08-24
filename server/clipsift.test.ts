import { describe, expect, it } from "vitest";
import { extractVideoId } from "./clipsift";

describe("extractVideoId", () => {
  it("accepts the supported YouTube URL forms used by Cut IQ", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("does not accept a lookalike host as a YouTube source", () => {
    expect(extractVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractVideoId("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});
