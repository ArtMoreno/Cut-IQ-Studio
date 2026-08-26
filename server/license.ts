import { createPublicKey, verify as verifySignature } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Offline Pro license verification.
 *
 * Cut IQ stays local-first: a key is an Ed25519 signature over a small payload,
 * so the app verifies it with an embedded public key and never contacts a
 * server. The matching private key lives only with the publisher, which means a
 * copy of this source can read keys but cannot mint them.
 */

// Replaced by scripts/keygen.mjs --init. Empty means every build is free-tier.
export const PUBLIC_KEY_HEX = "66016189cf8e9ceed912c773106fc0de642d0c8baec88897fc782a7296e0ef90";

const KEY_PREFIX = "CIQPRO-";
const PAYLOAD_VERSION = 1;

export const LICENSE_PATH = resolve(
  process.env.CUTIQ_LICENSE_PATH ||
    join(homedir(), ".cut-iq-studio", "license.key"),
);

export const PRO_FEATURES = ["batch_render", "clip_packages"] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export interface LicensePayload {
  v: number;
  tier: string;
  to: string;
  order: string;
}

export interface LicenseStatus {
  tier: "free" | "pro";
  features: ProFeature[];
  licensedTo: string | null;
}

const FREE: LicenseStatus = { tier: "free", features: [], licensedTo: null };

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Returns the payload for a valid key, or null when it does not verify.
 *
 * `publicKeyHex` exists so tests can sign with a throwaway keypair; production
 * callers always use the key compiled into this module.
 */
export function verifyKey(
  key: string,
  publicKeyHex: string = PUBLIC_KEY_HEX,
): LicensePayload | null {
  if (!publicKeyHex) return null;
  const cleaned = (key || "").trim().replace(/\s+/g, "");
  if (!cleaned.startsWith(KEY_PREFIX)) return null;

  const body = cleaned.slice(KEY_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;

  try {
    const payloadRaw = b64urlDecode(payloadPart);
    const signature = b64urlDecode(signaturePart);

    // Node builds an Ed25519 public key from the DER SubjectPublicKeyInfo
    // wrapper, so the 32 raw bytes get the fixed prefix prepended.
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    if (!verifySignature(null, payloadRaw, publicKey, signature)) return null;

    const payload = JSON.parse(payloadRaw.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return null;
    const candidate = payload as LicensePayload;
    if (candidate.v !== PAYLOAD_VERSION) return null;
    if (candidate.tier !== "pro") return null;
    return candidate;
  } catch {
    return null;
  }
}

export function storedKey(): string {
  try {
    return readFileSync(LICENSE_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

/** Persists a key only when it verifies. Returns the payload, or null. */
export function saveKey(key: string): LicensePayload | null {
  const payload = verifyKey(key);
  if (!payload) return null;
  mkdirSync(dirname(LICENSE_PATH), { recursive: true });
  writeFileSync(LICENSE_PATH, key.trim(), "utf8");
  return payload;
}

export function clearKey(): void {
  rmSync(LICENSE_PATH, { force: true });
}

/** The shape the UI reads to decide what to unlock. */
export function licenseStatus(): LicenseStatus {
  const payload = verifyKey(storedKey());
  if (!payload) return FREE;
  return {
    tier: "pro",
    features: [...PRO_FEATURES],
    licensedTo: payload.to ?? null,
  };
}

export function isPro(): boolean {
  return verifyKey(storedKey()) !== null;
}
