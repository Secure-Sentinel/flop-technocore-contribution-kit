import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  createEvidence,
  createIdentity,
  createProof,
  decryptIdentity,
  encryptIdentity,
  makeReadmeSnippet,
  makeShareText,
  sanitizeEvidence,
  validateArtifactUrl,
  validateBaseUrl,
  verifyProof,
} from "./src/core.js";
import { postWithRecovery } from "./src/network.js";
import {
  DEFAULT_EVIDENCE_PATH,
  DEFAULT_IDENTITY_PATH,
  loadIdentityRecord,
  loadOptionalJson,
  pathExists,
  saveEvidence,
  saveIdentityRecord,
} from "./src/storage.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const IDENTITY_PATH = DEFAULT_IDENTITY_PATH;
const EVIDENCE_PATH = DEFAULT_EVIDENCE_PATH;
const portIndex = process.argv.indexOf("--port");
const requestedPort = portIndex >= 0 ? process.argv[portIndex + 1] : null;
const parsedPort = Number(process.env.PORT || requestedPort || 5173);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 5173;
const HOST = process.env.HOST || "127.0.0.1";
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

async function bodyJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (body.length > 64 * 1024) throw new Error("Request body is too large.");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function unlock(passphrase) {
  const record = await loadIdentityRecord(IDENTITY_PATH);
  return { record, privateKey: decryptIdentity(record, passphrase) };
}

async function publicStatus() {
  if (!(await pathExists(IDENTITY_PATH))) return { exists: false, path: IDENTITY_PATH };
  const record = await loadIdentityRecord(IDENTITY_PATH);
  return { exists: true, path: IDENTITY_PATH, did: record.did, fingerprint: record.fingerprint };
}

function clientResult(result) {
  return {
    schema: result.schema,
    did: result.did,
    room: result.room,
    nonce: result.nonce,
    text: result.text,
    signature: result.signature,
    canonical: result.canonical,
    seq: result.seq,
    recordUrl: result.recordUrl,
    recovered: result.recovered === true,
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, { ok: true, ...(await publicStatus()) });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  const body = await bodyJson(request);

  if (url.pathname === "/api/init") {
    if (await pathExists(IDENTITY_PATH)) throw new Error("An identity already exists. Unlock it instead of creating another one.");
    if (typeof body.passphrase !== "string") throw new Error("Passphrase is required.");
    const identity = createIdentity();
    await saveIdentityRecord(IDENTITY_PATH, encryptIdentity(identity.privateKey, body.passphrase));
    sendJson(response, 200, { ok: true, did: identity.did, fingerprint: identity.fingerprint });
    return;
  }

  if (url.pathname === "/api/unlock") {
    const identity = await unlock(body.passphrase);
    sendJson(response, 200, { ok: true, did: identity.record.did, fingerprint: identity.record.fingerprint });
    return;
  }

  if (url.pathname === "/api/join") {
    const identity = await unlock(body.passphrase);
    const baseUrl = validateBaseUrl(body.baseUrl || DEFAULT_BASE_URL);
    const name = String(body.name || "new-contributor").toLowerCase();
    const message = body.message || `Hello from ${name}. I am preparing a useful public contribution for Technocore.`;
    const result = await postWithRecovery(identity.privateKey, "lobby", message, { baseUrl });
    sendJson(response, 200, { ok: true, result: clientResult(result) });
    return;
  }

  if (url.pathname === "/api/contribute") {
    const identity = await unlock(body.passphrase);
    const baseUrl = validateBaseUrl(body.baseUrl || DEFAULT_BASE_URL);
    const contributionUrl = validateArtifactUrl(body.url);
    const summary = String(body.summary || "a useful public contribution").trim();
    const type = body.type ? `${String(body.type).trim()} ` : "";
    const message = `I published a ${type}Technocore contribution: ${contributionUrl}. It helps people ${summary}.`;
    const result = await postWithRecovery(identity.privateKey, "technocore", message, { baseUrl });
    const oldEvidence = await loadOptionalJson(EVIDENCE_PATH);
    const evidence = createEvidence({
      did: result.did,
      baseUrl,
      lobby: oldEvidence?.lobby || null,
      contribution: result,
      contributionUrl,
      summary,
    });
    await saveEvidence(EVIDENCE_PATH, evidence);
    sendJson(response, 200, { ok: true, result: clientResult(result), evidence });
    return;
  }

  if (url.pathname === "/api/export") {
    const identity = await unlock(body.passphrase);
    const artifactUrl = validateArtifactUrl(body.artifactUrl);
    const evidence = await loadOptionalJson(EVIDENCE_PATH);
    const proof = createProof(identity.privateKey, { artifactUrl, commit: body.commit, evidence });
    verifyProof(proof);
    sendJson(response, 200, {
      ok: true,
      proof,
      files: {
        "public-proof.json": JSON.stringify(proof, null, 2) + "\n",
        "README-proof.md": makeReadmeSnippet(proof),
        "x-post.txt": makeShareText(proof),
      },
    });
    return;
  }

  if (url.pathname === "/api/verify") {
    const result = verifyProof(body.proof || body);
    sendJson(response, 200, { ok: true, result });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found." });
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_ROOT, relative);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    send(response, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    send(response, 200, content, CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (error.code === "ENOENT") send(response, 404, "Not found");
    else throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`FLOP Technocore Contribution Kit: http://${HOST}:${PORT}`);
  console.log("Local-only mode: the web wizard must not be exposed to the public internet.");
});
