import {
  DEFAULT_BASE_URL,
  ValidationError,
  messagePayload,
  signMessage,
  validateBaseUrl,
  validateName,
} from "./core.js";

export const DEFAULT_TIMEOUT_MS = 20_000;

export class NetworkError extends Error {
  constructor(message, { code = "NETWORK", status = null, recoverable = false, signed = null } = {}) {
    super(message);
    this.name = "NetworkError";
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
    this.signed = signed;
  }
}

function safeDetail(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ")
    .trim()
    .slice(0, 500);
}

async function request(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new NetworkError(`Request timed out after ${timeoutMs} ms.`, {
        code: "TIMEOUT",
        recoverable: true,
      });
    }
    throw new NetworkError(`Could not reach Technocore: ${safeDetail(error.message) || "unknown error"}`, {
      code: "UNREACHABLE",
      recoverable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options, timeoutMs, signed = null) {
  let response;
  try {
    response = await request(url, options, timeoutMs);
  } catch (error) {
    if (error instanceof NetworkError && signed) error.signed = signed;
    throw error;
  }
  const body = await response.text();
  if (!response.ok) {
    throw new NetworkError(
      `Technocore returned HTTP ${response.status}: ${safeDetail(body) || response.statusText || "no response body"}`,
      { code: `HTTP_${response.status}`, status: response.status, recoverable: response.status >= 500, signed },
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new NetworkError("Technocore returned a non-JSON response where JSON was expected.", {
      code: "INVALID_RESPONSE",
      recoverable: true,
      signed,
    });
  }
}

export async function readRoom(room, { baseUrl = DEFAULT_BASE_URL, since, limit = 200, wait, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const validBase = validateBaseUrl(baseUrl);
  const validRoom = validateName(room, "room");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError("Room limit must be between 1 and 200.");
  if (wait !== undefined && (!Number.isFinite(wait) || wait < 0 || wait > 10)) throw new ValidationError("Room wait must be between 0 and 10 seconds.");
  const query = new URLSearchParams({ format: "json", limit: String(limit), n: String(Date.now()) });
  if (since !== undefined) query.set("since", String(since));
  if (wait !== undefined) query.set("wait", String(wait));
  const response = await requestJson(`${validBase}/r/${validRoom}?${query}`, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": `flop-technocore-contribution-kit/${"0.1.0"}` },
  }, timeoutMs);
  if (response.room !== validRoom || !Array.isArray(response.messages)) {
    throw new NetworkError("Technocore returned an invalid room response.", { code: "INVALID_RESPONSE" });
  }
  return response;
}

export function findMessage(roomResponse, did, nonce) {
  return roomResponse.messages.find((message) => (
    message && message.from === did && String(message.nonce) === String(nonce)
  )) || null;
}

export async function postSignedMessage(privateKey, room, text, { baseUrl = DEFAULT_BASE_URL, nonce, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const validBase = validateBaseUrl(baseUrl);
  const signed = signMessage(privateKey, room, text, nonce);
  const body = JSON.stringify({
    did: signed.did,
    sig: signed.signature,
    nonce: signed.nonce,
    text: signed.text,
  });
  const response = await requestJson(`${validBase}/r/${signed.room}?format=json`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "flop-technocore-contribution-kit/0.1.0",
    },
    body,
  }, timeoutMs, signed);
  const posted = response.posted || {};
  if (posted.from && posted.from !== signed.did) throw new NetworkError("Server returned a different DID than the one that signed the message.", { code: "INVALID_RESPONSE", signed });
  if (posted.text && posted.text !== signed.text) throw new NetworkError("Server returned different message text than the signed payload.", { code: "INVALID_RESPONSE", signed });
  const seq = Number.isInteger(posted.seq) ? posted.seq : null;
  return {
    ...signed,
    baseUrl: validBase,
    posted,
    seq,
    recordUrl: seq ? `${validBase}/humans#r/${signed.room}/${seq}` : `${validBase}/r/${signed.room}?format=json`,
    recovered: false,
  };
}

export async function postWithRecovery(privateKey, room, text, options = {}) {
  try {
    return await postSignedMessage(privateKey, room, text, options);
  } catch (error) {
    if (!(error instanceof NetworkError) || !error.recoverable || !error.signed) throw error;
    try {
      const roomResponse = await readRoom(room, options);
      const found = findMessage(roomResponse, error.signed.did, error.signed.nonce);
      if (found) {
        const baseUrl = validateBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
        const seq = Number.isInteger(found.seq) ? found.seq : null;
        return {
          ...error.signed,
          baseUrl,
          posted: found,
          seq,
          recordUrl: seq ? `${baseUrl}/humans#r/${error.signed.room}/${seq}` : `${baseUrl}/r/${error.signed.room}?format=json`,
          recovered: true,
        };
      }
    } catch (recoveryError) {
      error.recoveryError = recoveryError;
    }
    error.message = `${error.message} The result is unknown; no matching DID/nonce was found during recovery. Do not blindly resend the same nonce.`;
    throw error;
  }
}

export async function healthCheck(baseUrl = DEFAULT_BASE_URL, timeoutMs = 10_000) {
  const validBase = validateBaseUrl(baseUrl);
  const response = await request(`${validBase}/healthz`, { method: "GET", headers: { Accept: "text/plain" } }, timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new NetworkError(`Technocore health check returned HTTP ${response.status}.`, { code: `HTTP_${response.status}`, status: response.status });
  return text.trim();
}

