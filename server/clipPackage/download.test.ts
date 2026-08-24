import { describe, expect, it } from "vitest";
import { packageVersionContentDisposition, packageVersionDownloadName } from "./download";

describe("edited package download headers", () => {
  it("uses only a sanitized basename and RFC 5987 encoding", () => {
    const file = 'D:\\Clips\\Manual Clip Studio\\Xavier "longer" context.mp4';
    expect(packageVersionDownloadName(file)).toBe("Xavier  longer  context.mp4");
    expect(packageVersionContentDisposition(file, true)).toBe(
      "attachment; filename*=UTF-8''Xavier%20%20longer%20%20context.mp4",
    );
  });

  it("keeps preview responses inline", () => {
    expect(packageVersionContentDisposition("D:/Clips/revised.mp4", false)).toBe("inline");
  });
});
