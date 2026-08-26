import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let licenseDir: string;

beforeAll(() => {
  licenseDir = mkdtempSync(join(tmpdir(), "cutiq-license-"));
  process.env.CUTIQ_LICENSE_PATH = join(licenseDir, "license.key");
});

afterAll(() => {
  rmSync(licenseDir, { recursive: true, force: true });
});

function makeSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicHex = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  )
    .subarray(-32)
    .toString("hex");
  return { privateKey, publicHex };
}

function mint(
  privateKey: ReturnType<typeof createPrivateKey>,
  payload: Record<string, unknown>,
) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, raw, privateKey);
  return `CIQPRO-${raw.toString("base64url")}.${signature.toString("base64url")}`;
}

const validPayload = {
  order: "gum-1",
  tier: "pro",
  to: "buyer@example.com",
  v: 1,
};

describe("Pro key verification", () => {
  it("accepts a key signed by the matching private key", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey, publicHex } = makeSigner();
    const payload = verifyKey(mint(privateKey, validPayload), publicHex);
    expect(payload?.to).toBe("buyer@example.com");
  });

  it("rejects a key whose payload was altered after signing", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey, publicHex } = makeSigner();
    const key = mint(privateKey, validPayload);
    expect(verifyKey(`${key.slice(0, -4)}AAAA`, publicHex)).toBeNull();
  });

  it("rejects a key signed by a different keypair", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey } = makeSigner();
    const { publicHex: otherPublicHex } = makeSigner();
    expect(verifyKey(mint(privateKey, validPayload), otherPublicHex)).toBeNull();
  });

  it("rejects a free payload forged into a pro claim shape", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey, publicHex } = makeSigner();
    const key = mint(privateKey, { ...validPayload, tier: "free" });
    expect(verifyKey(key, publicHex)).toBeNull();
  });

  it("rejects an unknown payload version", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey, publicHex } = makeSigner();
    expect(verifyKey(mint(privateKey, { ...validPayload, v: 99 }), publicHex)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    const { verifyKey } = await import("./license");
    const { publicHex } = makeSigner();
    for (const bad of ["", "CIQPRO-", "CIQPRO-nonsense", "not-a-key", "CIQPRO-a.b.c"]) {
      expect(verifyKey(bad, publicHex)).toBeNull();
    }
  });

  it("stays free-tier when no public key is compiled in", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey } = makeSigner();
    expect(verifyKey(mint(privateKey, validPayload), "")).toBeNull();
  });

  it("tolerates surrounding whitespace from a copy-paste", async () => {
    const { verifyKey } = await import("./license");
    const { privateKey, publicHex } = makeSigner();
    const key = mint(privateKey, validPayload);
    expect(verifyKey(`  ${key}\n`, publicHex)).not.toBeNull();
  });
});
