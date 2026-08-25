import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

export const APP_VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://technocore.chat";
export const IDENTITY_SCHEMA = "flop-technocore-identity-v1";
export const EVIDENCE_SCHEMA = "flop-technocore-evidence-v1";
export const PROOF_SCHEMA = "flop-technocore-contribution-proof-v1";
export const MESSAGE_SCHEMA = "flop-technocore-signed-message-v1";
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_NAME_CHARS = 48;
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });

const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);
const BASE58BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58BTC_INDEX = new Map(
  [...BASE58BTC_ALPHABET].map((character, index) => [character, index]),
);
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const NONCE_PATTERN = /^[0-9]{1,19}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class IdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentityError";
  }
}

export function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

export function base64urlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ValidationError("Invalid base64url data.");
  }
  return Buffer.from(value, "base64url");
}

export function base58btcEncode(data) {
  const bytes = Buffer.from(data);
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;

  let number = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58BTC_ALPHABET[remainder] + encoded;
    number /= 58n;
  }
  return "1".repeat(zeroes) + encoded;
}

export function base58btcDecode(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("Base58btc value cannot be empty.");
  }
  let number = 0n;
  for (const character of value) {
    const digit = BASE58BTC_INDEX.get(character);
    if (digit === undefined) {
      throw new ValidationError(`Invalid base58btc character: ${character}`);
    }
    number = number * 58n + BigInt(digit);
  }

  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const decoded = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes += 1;
  return Buffer.concat([Buffer.alloc(zeroes), decoded]);
}

function publicKeyBytesFromPrivateKey(privateKey) {
  let jwk;
  try {
    jwk = createPublicKey(privateKey).export({ format: "jwk" });
  } catch (error) {
    throw new IdentityError(`Could not read the Ed25519 public key: ${error.message}`);
  }
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new IdentityError("Identity is not an Ed25519 key.");
  }
  const publicBytes = base64urlDecode(jwk.x);
  if (publicBytes.length !== 32) throw new IdentityError("Ed25519 public key has an invalid length.");
  return publicBytes;
}

export function didFromPrivateKey(privateKey) {
  const publicBytes = publicKeyBytesFromPrivateKey(privateKey);
  return `did:key:z${base58btcEncode(Buffer.concat([MULTICODEC_ED25519, publicBytes]))}`;
}

export function publicKeyFromDid(did) {
  if (typeof did !== "string" || !did.startsWith("did:key:z6Mk")) {
    throw new ValidationError("DID must start with did:key:z6Mk.");
  }
  const multibase = did.slice("did:key:".length);
  const decoded = base58btcDecode(multibase.slice(1));
  if (multibase.length !== 48 || !multibase.startsWith("z6Mk") || decoded.length !== 34) {
    throw new ValidationError("DID must be the canonical 48-character Ed25519 did:key form.");
  }
  if (!decoded.subarray(0, 2).equals(MULTICODEC_ED25519)) {
    throw new ValidationError("DID does not contain an Ed25519 public key.");
  }
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: base64urlEncode(decoded.subarray(2)),
    },
    format: "jwk",
  });
}

export function fingerprintForDid(did) {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

export function normalizeText(text, limit = MAX_MESSAGE_CHARS) {
  if (typeof text !== "string") throw new ValidationError("Message text must be a string.");
  const normalized = text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, " ").trim();
  if (!normalized) throw new ValidationError("Message has no visible text after normalization.");
  if ([...normalized].length > limit) {
    throw new ValidationError(`Message is longer than the ${limit}-character limit.`);
  }
  return normalized;
}

export function validateName(value, label = "name") {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new ValidationError(`${label} must match ^[a-z0-9][a-z0-9_-]{0,47}$`);
  }
  return value;
}

export function validateNonce(value) {
  const nonce = String(value);
  if (!NONCE_PATTERN.test(nonce)) throw new ValidationError("Nonce must contain 1-19 ASCII digits.");
  return nonce;
}

export function nextNonce() {
  return validateNonce(Date.now());
}

export function validateBaseUrl(value) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new ValidationError("Technocore URL must be a non-empty URL without surrounding spaces.");
  }
  let parsed;
  try {
    parsed = new URL(value.replace(/\/$/, ""));
  } catch {
    throw new ValidationError("Technocore URL is malformed.");
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new ValidationError("Technocore URL must use HTTPS, except for localhost testing.");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ValidationError("Technocore URL must not contain credentials, query parameters, or fragments.");
  }
  if (parsed.pathname !== "/") throw new ValidationError("Technocore URL must not contain a path.");
  return parsed.origin;
}

export function validateArtifactUrl(value) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new ValidationError("Contribution URL must be a public HTTP(S) URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError("Contribution URL is malformed.");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ValidationError("Contribution URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) throw new ValidationError("Contribution URL must not contain credentials.");
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new ValidationError("Use an HTTPS URL for a public contribution.");
  }
  return parsed.toString();
}

export function validateCommit(value) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new ValidationError("Commit must be a complete 40- or 64-character hexadecimal revision.");
  }
  return value.toLowerCase();
}

export function validatePassphrase(value) {
  if (typeof value !== "string" || value.length < 12) {
    throw new IdentityError("Identity passphrase must contain at least 12 characters.");
  }
  return value;
}

export function createIdentity() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const did = didFromPrivateKey(privateKey);
  return { privateKey, did, fingerprint: fingerprintForDid(did) };
}

function deriveEncryptionKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, {
    ...SCRYPT_PARAMS,
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptIdentity(privateKey, passphrase) {
  validatePassphrase(passphrase);
  const did = didFromPrivateKey(privateKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveEncryptionKey(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const ciphertext = Buffer.concat([cipher.update(privateDer), cipher.final()]);
    return {
      schema: IDENTITY_SCHEMA,
      version: 1,
      did,
      fingerprint: fingerprintForDid(did),
      created_at: new Date().toISOString(),
      kdf: { name: "scrypt", ...SCRYPT_PARAMS },
      cipher: {
        name: "aes-256-gcm",
        salt: base64urlEncode(salt),
        iv: base64urlEncode(iv),
        tag: base64urlEncode(cipher.getAuthTag()),
        ciphertext: base64urlEncode(ciphertext),
      },
    };
  } finally {
    key.fill(0);
  }
}

export function decryptIdentity(record, passphrase) {
  validatePassphrase(passphrase);
  if (!record || record.schema !== IDENTITY_SCHEMA || record.version !== 1) {
    throw new IdentityError("Identity file has an unsupported format.");
  }
  let salt;
  let iv;
  let tag;
  let ciphertext;
  try {
    salt = base64urlDecode(record.cipher.salt);
    iv = base64urlDecode(record.cipher.iv);
    tag = base64urlDecode(record.cipher.tag);
    ciphertext = base64urlDecode(record.cipher.ciphertext);
  } catch (error) {
    throw new IdentityError(`Identity file is corrupted: ${error.message}`);
  }
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new IdentityError("Identity file has invalid encrypted key data.");
  }
  const key = deriveEncryptionKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const privateDer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const did = didFromPrivateKey(privateKey);
    if (did !== record.did) throw new IdentityError("Identity DID does not match its key.");
    return privateKey;
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("Could not unlock identity. Check the passphrase.");
  } finally {
    key.fill(0);
  }
}

export function messagePayload(room, nonce, text) {
  const validRoom = validateName(room, "room");
  const validNonce = validateNonce(nonce);
  const normalized = normalizeText(text);
  const canonical = `${validRoom}|${validNonce}|${normalized}`;
  return { room: validRoom, nonce: validNonce, text: normalized, canonical };
}

export function signMessage(privateKey, room, text, nonce = nextNonce()) {
  const payload = messagePayload(room, nonce, text);
  const did = didFromPrivateKey(privateKey);
  const signature = base64urlEncode(signBytes(null, Buffer.from(payload.canonical, "utf8"), privateKey));
  if (!SIGNATURE_PATTERN.test(signature)) throw new IdentityError("Generated an invalid signature.");
  return {
    schema: MESSAGE_SCHEMA,
    did,
    room: payload.room,
    nonce: payload.nonce,
    text: payload.text,
    signature,
    canonical: payload.canonical,
  };
}

export function verifySignedMessage(message) {
  if (!message || message.schema !== MESSAGE_SCHEMA) {
    throw new ValidationError("Unsupported signed message evidence schema.");
  }
  const payload = messagePayload(message.room, message.nonce, message.text);
  if (payload.text !== message.text || payload.canonical !== message.canonical) {
    throw new ValidationError("Signed message canonical payload does not match its text.");
  }
  if (!SIGNATURE_PATTERN.test(message.signature || "")) {
    throw new ValidationError("Signed message signature has an invalid format.");
  }
  const valid = verifyBytes(
    null,
    Buffer.from(payload.canonical, "utf8"),
    publicKeyFromDid(message.did),
    base64urlDecode(message.signature),
  );
  if (!valid) throw new IdentityError("Signed message signature does not match the DID.");
  return true;
}

export function publicMessageEvidence(result) {
  const seq = result.seq ?? result.posted?.seq ?? null;
  return {
    schema: MESSAGE_SCHEMA,
    did: result.did,
    room: result.room,
    nonce: String(result.nonce),
    text: result.text,
    signature: result.signature,
    canonical: result.canonical,
    seq: Number.isInteger(seq) ? seq : null,
    url: result.recordUrl || null,
    recovered: result.recovered === true,
  };
}

export function createEvidence({ did, baseUrl, lobby = null, contribution = null, contributionUrl, summary }) {
  return {
    schema: EVIDENCE_SCHEMA,
    version: 1,
    created_at: new Date().toISOString(),
    did,
    fingerprint: fingerprintForDid(did),
    base_url: validateBaseUrl(baseUrl),
    contribution_url: contributionUrl ? validateArtifactUrl(contributionUrl) : null,
    summary: summary || null,
    lobby: lobby ? publicMessageEvidence(lobby) : null,
    contribution: contribution ? publicMessageEvidence(contribution) : null,
  };
}

export function sanitizeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  const clean = {
    schema: EVIDENCE_SCHEMA,
    version: 1,
    created_at: typeof evidence.created_at === "string" ? evidence.created_at : undefined,
    did: evidence.did,
    fingerprint: evidence.fingerprint,
    base_url: evidence.base_url,
    contribution_url: evidence.contribution_url,
    summary: evidence.summary,
    lobby: evidence.lobby || null,
    contribution: evidence.contribution || null,
  };
  if (clean.lobby) verifySignedMessage(clean.lobby);
  if (clean.contribution) verifySignedMessage(clean.contribution);
  if (clean.did && clean.lobby && clean.lobby.did !== clean.did) {
    throw new ValidationError("Evidence lobby DID does not match the evidence DID.");
  }
  if (clean.did && clean.contribution && clean.contribution.did !== clean.did) {
    throw new ValidationError("Evidence contribution DID does not match the evidence DID.");
  }
  return clean;
}

function proofPayload(artifactUrl, commit) {
  return JSON.stringify({
    artifact_url: validateArtifactUrl(artifactUrl),
    commit: validateCommit(commit),
    schema: PROOF_SCHEMA,
  });
}

export function createProof(privateKey, { artifactUrl, commit, evidence = null }) {
  const normalizedUrl = validateArtifactUrl(artifactUrl);
  const normalizedCommit = validateCommit(commit);
  const did = didFromPrivateKey(privateKey);
  const payload = proofPayload(normalizedUrl, normalizedCommit);
  const proof = {
    schema: PROOF_SCHEMA,
    version: 1,
    did,
    artifact_url: normalizedUrl,
    commit: normalizedCommit,
    signed_payload: payload,
    signature: base64urlEncode(signBytes(null, Buffer.from(payload, "utf8"), privateKey)),
  };
  if (evidence) proof.evidence = sanitizeEvidence(evidence);
  return proof;
}

export function verifyProof(proof) {
  if (!proof || proof.schema !== PROOF_SCHEMA || proof.version !== 1) {
    throw new ValidationError("Unsupported contribution proof schema.");
  }
  const payload = proofPayload(proof.artifact_url, proof.commit);
  if (proof.signed_payload !== payload) throw new ValidationError("Proof canonical payload does not match.");
  if (!SIGNATURE_PATTERN.test(proof.signature || "")) throw new ValidationError("Proof signature has an invalid format.");
  const valid = verifyBytes(
    null,
    Buffer.from(payload, "utf8"),
    publicKeyFromDid(proof.did),
    base64urlDecode(proof.signature),
  );
  if (!valid) throw new IdentityError("Proof signature does not match the DID.");
  const evidence = proof.evidence ? sanitizeEvidence(proof.evidence) : null;
  if (evidence?.did && evidence.did !== proof.did) {
    throw new ValidationError("Proof evidence DID does not match the proof DID.");
  }
  return {
    valid: true,
    did: proof.did,
    artifactUrl: proof.artifact_url,
    commit: proof.commit,
    evidence: {
      lobby: Boolean(evidence?.lobby),
      contribution: Boolean(evidence?.contribution),
    },
  };
}

export function makeReadmeSnippet(proof) {
  const contribution = proof.evidence?.contribution;
  const record = contribution?.url || "(run `onboard` or `contribute` to create the public record link)";
  return [
    "## Technocore contribution proof",
    "",
    "This repository contains a useful public contribution for the FLOP Technocore ecosystem.",
    "",
    `- Contribution: ${proof.artifact_url}`,
    `- DID: \`${proof.did}\``,
    `- Commit: \`${proof.commit}\``,
    `- Signed Technocore record: ${record}`,
    `- Offline proof: \`public-proof.json\` (verified with \`node flop.js verify public-proof.json\`)`,
    "",
    "This proof documents authorship and participation; it does not guarantee any FLOP allocation.",
    "",
  ].join("\n");
}

export function makeShareText(proof) {
  const contribution = proof.evidence?.contribution;
  const record = contribution?.url || "public Technocore record";
  return [
    "I published a useful public contribution for Technocore by @flop_labs.",
    "",
    `Contribution: ${proof.artifact_url}`,
    `Agent DID: ${proof.did}`,
    `Signed Technocore record: ${record}`,
    `Proof commit: ${proof.commit}`,
  ].join("\n");
}

