#!/usr/bin/env node
/**
 * Publisher-side signing tool for Cut IQ Studio Pro keys.
 *
 * Run --init once to create the signing keypair. The private key is written
 * outside the repository so it can never be committed; the public half is
 * patched into server/license.ts, which ships with the app.
 *
 *   node scripts/keygen.mjs --init
 *   node scripts/keygen.mjs --issue --to buyer@example.com --order gumroad-1234
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const LICENSE_MODULE = join(REPO_ROOT, "server", "license.ts");
const PRIVATE_KEY_PATH = join(homedir(), ".cut-iq-keys", "signing.key");
const KEY_PREFIX = "CIQPRO-";
const PAYLOAD_VERSION = 1;

function die(message) {
  console.error(message);
  process.exit(1);
}

function init() {
  if (existsSync(PRIVATE_KEY_PATH)) {
    die(
      `a signing key already exists at ${PRIVATE_KEY_PATH}\n` +
        "Refusing to overwrite it: every key you have already sold was signed " +
        "with it, and replacing it would invalidate all of them.",
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  // Raw 32-byte halves live at the tail of each DER structure.
  const privateHex = Buffer.from(privateDer).subarray(-32).toString("hex");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicHex = Buffer.from(publicDer).subarray(-32).toString("hex");

  mkdirSync(dirname(PRIVATE_KEY_PATH), { recursive: true });
  writeFileSync(PRIVATE_KEY_PATH, privateHex, { encoding: "utf8", mode: 0o600 });

  const source = readFileSync(LICENSE_MODULE, "utf8");
  const patched = source.replace(
    /^export const PUBLIC_KEY_HEX = ".*";$/m,
    `export const PUBLIC_KEY_HEX = "${publicHex}";`,
  );
  if (patched === source) {
    die(`could not find PUBLIC_KEY_HEX in ${LICENSE_MODULE}`);
  }
  writeFileSync(LICENSE_MODULE, patched, "utf8");

  console.log(`private signing key -> ${PRIVATE_KEY_PATH}`);
  console.log(`public key patched  -> ${LICENSE_MODULE}`);
  console.log(
    "\nBack up the private key somewhere safe. Losing it means you can no\n" +
      "longer issue keys; leaking it means anyone can.",
  );
}

function issue(to, order) {
  let privateHex;
  try {
    privateHex = readFileSync(PRIVATE_KEY_PATH, "utf8").trim();
  } catch {
    die(`no signing key at ${PRIVATE_KEY_PATH} - run --init first`);
  }

  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(privateHex, "hex"),
  ]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });

  // Key order is fixed so the signed bytes are reproducible.
  const payload = { order, tier: "pro", to, v: PAYLOAD_VERSION };
  const payloadRaw = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = signPayload(null, payloadRaw, privateKey);

  console.log(
    `${KEY_PREFIX}${payloadRaw.toString("base64url")}.${signature.toString("base64url")}`,
  );
}

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

if (args.includes("--init")) {
  init();
} else if (args.includes("--issue")) {
  const to = flag("--to");
  if (!to) die("--issue requires --to");
  issue(to, flag("--order") || "");
} else {
  console.log(
    "usage:\n  node scripts/keygen.mjs --init\n" +
      "  node scripts/keygen.mjs --issue --to buyer@example.com --order gumroad-1234",
  );
  process.exit(1);
}
