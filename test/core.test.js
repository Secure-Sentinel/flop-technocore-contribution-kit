import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  base58btcDecode,
  base58btcEncode,
  createIdentity,
  createProof,
  decryptIdentity,
  encryptIdentity,
  messagePayload,
  normalizeText,
  signMessage,
  verifyProof,
  verifySignedMessage,
} from "../src/core.js";
import { saveIdentityRecord } from "../src/storage.js";

test("base58btc preserves bytes", () => {
  const source = Buffer.from([0, 0, 1, 2, 250, 255]);
  assert.deepEqual(base58btcDecode(base58btcEncode(source)), source);
});

test("message normalization mirrors the single-line protocol", () => {
  assert.equal(normalizeText(" hello\nworld\u200b "), "hello world");
  assert.deepEqual(messagePayload("lobby", "123", "hello\nworld"), {
    room: "lobby",
    nonce: "123",
    text: "hello world",
    canonical: "lobby|123|hello world",
  });
});

test("signed messages verify against their did:key", () => {
  const identity = createIdentity();
  const message = signMessage(identity.privateKey, "lobby", "hello", "123456789");
  assert.equal(message.did, identity.did);
  assert.equal(verifySignedMessage(message), true);
  assert.throws(() => verifySignedMessage({ ...message, text: "tampered" }), /canonical|signature/i);
});

test("encrypted identity decrypts to the same DID and rejects a wrong passphrase", () => {
  const identity = createIdentity();
  const record = encryptIdentity(identity.privateKey, "a sufficiently long test passphrase");
  const restored = decryptIdentity(record, "a sufficiently long test passphrase");
  const message = signMessage(restored, "lobby", "same identity", "456");
  assert.equal(message.did, identity.did);
  assert.throws(() => decryptIdentity(record, "wrong passphrase"), /unlock|passphrase/i);
});

test("proofs verify offline and detect tampering", () => {
  const identity = createIdentity();
  const lobby = signMessage(identity.privateKey, "lobby", "hello", "1");
  const contribution = signMessage(identity.privateKey, "technocore", "I published a contribution", "2");
  const proof = createProof(identity.privateKey, {
    artifactUrl: "https://github.com/example/contribution",
    commit: "a".repeat(40),
    evidence: {
      did: identity.did,
      base_url: "https://technocore.chat",
      lobby,
      contribution,
    },
  });
  assert.equal(verifyProof(proof).valid, true);
  assert.throws(() => verifyProof({ ...proof, artifact_url: "https://example.com/tampered" }), /canonical|signature/i);
});

test("identity files are created without overwriting an existing file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flop-kit-"));
  try {
    const filePath = path.join(directory, "identity.json");
    const identity = createIdentity();
    await saveIdentityRecord(filePath, encryptIdentity(identity.privateKey, "another sufficiently long passphrase"));
    const first = await readFile(filePath, "utf8");
    await assert.rejects(
      saveIdentityRecord(filePath, encryptIdentity(createIdentity().privateKey, "another sufficiently long passphrase")),
      /overwrite/i,
    );
    assert.equal(await readFile(filePath, "utf8"), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

