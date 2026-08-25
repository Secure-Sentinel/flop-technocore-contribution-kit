import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  APP_VERSION,
  createEvidence,
  createIdentity,
  createProof,
  decryptIdentity,
  encryptIdentity,
  fingerprintForDid,
  makeReadmeSnippet,
  makeShareText,
  sanitizeEvidence,
  validateArtifactUrl,
  validateBaseUrl,
  verifyProof,
} from "./core.js";
import { healthCheck, postWithRecovery } from "./network.js";
import {
  DEFAULT_EVIDENCE_PATH,
  DEFAULT_IDENTITY_PATH,
  loadIdentityRecord,
  loadOptionalJson,
  pathExists,
  readJson,
  resolveUserPath,
  saveEvidence,
  saveIdentityRecord,
  writeJsonExclusive,
  writeTextExclusive,
} from "./storage.js";

const execFileAsync = promisify(execFile);

function parseOptions(tokens) {
  const options = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
    } else if (tokens[index + 1] && !tokens[index + 1].startsWith("--")) {
      options[key] = tokens[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function identityPathFrom(options) {
  return resolveUserPath(options.identity, DEFAULT_IDENTITY_PATH);
}

function evidencePathFrom(options) {
  return resolveUserPath(options.evidence, DEFAULT_EVIDENCE_PATH);
}

function baseUrlFrom(options) {
  return validateBaseUrl(options.base_url || process.env.TECHNOCORE_URL || DEFAULT_BASE_URL);
}

function required(options, key, label = key) {
  if (typeof options[key] !== "string" || !options[key].trim()) throw new Error(`Missing required option: --${label}`);
  return options[key].trim();
}

async function promptSecret(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        const code = character.charCodeAt(0);
        if (code === 3) {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (code === 10 || code === 13) {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (code === 8 || code === 127) {
          if (value.length) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (code >= 32) {
          value += character;
          output.write("*");
        }
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function promptPassphrase(confirm = false) {
  const first = await promptSecret(confirm ? "New identity passphrase (12+ characters): " : "Identity passphrase: ");
  if (!confirm) return first;
  const second = await promptSecret("Confirm identity passphrase: ");
  if (first !== second) throw new Error("Passphrases do not match.");
  return first;
}

async function unlock(options, passphrase = null) {
  const identityPath = identityPathFrom(options);
  const record = await loadIdentityRecord(identityPath);
  const selected = passphrase ?? await promptPassphrase(false);
  const privateKey = decryptIdentity(record, selected);
  return { privateKey, record, identityPath };
}

async function ensureIdentity(options, passphrase = null) {
  const identityPath = identityPathFrom(options);
  if (await pathExists(identityPath)) return unlock(options, passphrase);
  const selected = passphrase ?? await promptPassphrase(true);
  const identity = createIdentity();
  const record = encryptIdentity(identity.privateKey, selected);
  await saveIdentityRecord(identityPath, record);
  console.log(`Created encrypted identity: ${identityPath}`);
  console.log(`DID: ${identity.did}`);
  return { privateKey: identity.privateKey, record, identityPath };
}

function printPublished(label, result) {
  console.log(`\n✓ ${label}${result.recovered ? " (confirmed during timeout recovery)" : ""}`);
  console.log(`  DID:      ${result.did}`);
  console.log(`  Room:     ${result.room}`);
  console.log(`  Sequence: ${result.seq ?? "unknown"}`);
  console.log(`  Record:   ${result.recordUrl}`);
  console.log(`  Nonce:    ${result.nonce}`);
}

async function saveEvidenceFromRun(options, { lobby = null, contribution = null, did, baseUrl, url, summary }) {
  const evidencePath = evidencePathFrom(options);
  const current = await loadOptionalJson(evidencePath);
  const evidence = createEvidence({
    did,
    baseUrl,
    lobby: lobby || current?.lobby ? lobby || current.lobby : null,
    contribution: contribution || current?.contribution ? contribution || current.contribution : null,
    contributionUrl: url || current?.contribution_url || null,
    summary: summary || current?.summary || null,
  });
  await saveEvidence(evidencePath, evidence);
  return { evidencePath, evidence };
}

async function commandInit(options) {
  const identityPath = identityPathFrom(options);
  if (await pathExists(identityPath)) throw new Error(`Identity already exists at ${identityPath}; refusing to overwrite it.`);
  const passphrase = await promptPassphrase(true);
  const identity = createIdentity();
  await saveIdentityRecord(identityPath, encryptIdentity(identity.privateKey, passphrase));
  console.log(`Created encrypted identity: ${identityPath}`);
  console.log(`DID: ${identity.did}`);
  console.log(`Fingerprint: ${identity.fingerprint}`);
  console.log("Keep the passphrase and identity file safe. The identity file must never be committed.");
}

async function commandDid(options) {
  const { record, identityPath } = await unlock(options);
  console.log(`DID: ${record.did}`);
  console.log(`Fingerprint: ${record.fingerprint || fingerprintForDid(record.did)}`);
  console.log(`Identity: ${identityPath}`);
}

async function commandJoin(options, existingPrivateKey = null) {
  const name = required(options, "name");
  const message = options.message || `Hello from ${name}. I am preparing a useful public contribution for Technocore.`;
  const baseUrl = baseUrlFrom(options);
  const identity = existingPrivateKey ? { privateKey: existingPrivateKey } : await unlock(options);
  const result = await postWithRecovery(identity.privateKey, "lobby", message, { baseUrl });
  printPublished("Joined Technocore lobby", result);
  return result;
}

async function commandContribute(options, existingPrivateKey = null) {
  const url = validateArtifactUrl(required(options, "url"));
  const summary = required(options, "summary");
  const type = options.type ? `${options.type} ` : "";
  const text = `I published a ${type}Technocore contribution: ${url}. It helps people ${summary}.`;
  const baseUrl = baseUrlFrom(options);
  const identity = existingPrivateKey ? { privateKey: existingPrivateKey } : await unlock(options);
  const result = await postWithRecovery(identity.privateKey, "technocore", text, { baseUrl });
  printPublished("Registered contribution", result);
  await saveEvidenceFromRun(options, {
    contribution: result,
    did: result.did,
    baseUrl,
    url,
    summary,
  });
  console.log(`  Local evidence: ${evidencePathFrom(options)}`);
  return result;
}

async function commandOnboard(options) {
  const name = options.name || "new-contributor";
  const url = validateArtifactUrl(required(options, "url"));
  const summary = required(options, "summary");
  const passphrase = await (await pathExists(identityPathFrom(options)) ? promptPassphrase(false) : promptPassphrase(true));
  const identity = await ensureIdentity(options, passphrase);
  const baseUrl = baseUrlFrom(options);
  const lobby = await commandJoin({ ...options, name }, identity.privateKey);
  const contribution = await commandContribute({ ...options, url, summary }, identity.privateKey);
  const saved = await saveEvidenceFromRun(options, { lobby, contribution, did: lobby.did, baseUrl, url, summary });
  console.log(`\nEvidence saved locally: ${saved.evidencePath}`);
  console.log("Next: publish the repository, get its final commit hash, then run:");
  console.log(`  node flop.js export --artifact ${url} --commit <FULL_COMMIT_HASH>`);
}

async function readEvidence(options) {
  const evidence = await loadOptionalJson(evidencePathFrom(options));
  return evidence ? sanitizeEvidence(evidence) : null;
}

async function currentCommit() {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function makeProof(options) {
  const artifactUrl = validateArtifactUrl(required(options, "artifact", "artifact"));
  const commit = options.commit || await currentCommit();
  if (!commit) throw new Error("Missing --commit and no current Git commit was found.");
  const identity = await unlock(options);
  const evidence = await readEvidence(options);
  const proof = createProof(identity.privateKey, { artifactUrl, commit, evidence });
  verifyProof(proof);
  return proof;
}

async function commandProof(options) {
  const proof = await makeProof(options);
  const outputPath = resolveUserPath(options.output, path.resolve("public-proof.json"));
  await writeJsonExclusive(outputPath, proof);
  console.log(`Verified and wrote public proof: ${outputPath}`);
  console.log(`DID: ${proof.did}`);
  console.log(`Commit: ${proof.commit}`);
  console.log("This JSON contains no private key or passphrase and can be committed publicly.");
}

async function commandExport(options) {
  const proof = await makeProof(options);
  const outDir = resolveUserPath(options.out_dir, path.resolve("proof-kit"));
  const proofPath = path.join(outDir, "public-proof.json");
  const readmePath = path.join(outDir, "README-proof.md");
  const sharePath = path.join(outDir, "x-post.txt");
  await writeJsonExclusive(proofPath, proof);
  await writeTextExclusive(readmePath, makeReadmeSnippet(proof));
  await writeTextExclusive(sharePath, makeShareText(proof));
  console.log(`Proof kit created in: ${outDir}`);
  console.log(`- ${proofPath}`);
  console.log(`- ${readmePath}`);
  console.log(`- ${sharePath}`);
}

async function commandVerify(options) {
  const filePath = options._[0] || options.file;
  if (!filePath) throw new Error("Usage: node flop.js verify <proof.json>");
  const proof = await readJson(path.resolve(filePath));
  const result = verifyProof(proof);
  console.log("Valid Technocore contribution proof.");
  console.log(`DID: ${result.did}`);
  console.log(`Artifact: ${result.artifactUrl}`);
  console.log(`Commit: ${result.commit}`);
  console.log(`Lobby evidence: ${result.evidence.lobby ? "verified" : "not included"}`);
  console.log(`Contribution evidence: ${result.evidence.contribution ? "verified" : "not included"}`);
}

async function commandDoctor(options) {
  const identityPath = identityPathFrom(options);
  const baseUrl = baseUrlFrom(options);
  console.log(`FLOP Technocore Contribution Kit v${APP_VERSION}`);
  console.log(`Node: ${process.version}`);
  console.log(`Identity: ${await pathExists(identityPath) ? `found at ${identityPath}` : "not created yet"}`);
  console.log(`Technocore: checking ${baseUrl} ...`);
  console.log(`Health: ${await healthCheck(baseUrl) || "ok"}`);
}

function printHelp() {
  console.log(`FLOP Technocore Contribution Kit v${APP_VERSION}

Quick start:
  npm start
  node flop.js onboard --name my-agent --url https://github.com/me/my-contribution --summary "learn how to create a DID and publish a signed contribution"

Commands:
  init         Create one encrypted local identity.
  did          Show the public DID after unlocking the identity.
  join         Publish one signed message to the lobby.
  contribute   Register a public contribution in the technocore room.
  onboard      Run init (if needed), join, and contribute in one flow.
  proof        Create and verify a public proof JSON for a Git commit.
  export       Create proof JSON, README snippet, and X post text.
  verify       Verify a proof offline without the private key.
  doctor       Check the local identity and Technocore health endpoint.

Common options:
  --identity PATH     Encrypted identity path (default: .flop/identity.json)
  --evidence PATH     Local evidence path (default: .flop/evidence.json)
  --base-url URL      Technocore URL (default: https://technocore.chat)
`);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const options = parseOptions(argv.slice(1));
  if (command === "--version" || command === "version") {
    console.log(APP_VERSION);
    return;
  }
  switch (command) {
    case "init": return commandInit(options);
    case "did": return commandDid(options);
    case "join": return commandJoin(options);
    case "contribute": return commandContribute(options);
    case "onboard": return commandOnboard(options);
    case "proof": return commandProof(options);
    case "export": return commandExport(options);
    case "verify": return commandVerify(options);
    case "doctor": return commandDoctor(options);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run node flop.js help.`);
  }
}
