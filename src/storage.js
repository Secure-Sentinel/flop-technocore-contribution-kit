import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IDENTITY_PATH = path.resolve(process.env.FLOP_IDENTITY_PATH || path.join(process.cwd(), ".flop", "identity.json"));
export const DEFAULT_EVIDENCE_PATH = path.resolve(process.env.FLOP_EVIDENCE_PATH || path.join(process.cwd(), ".flop", "evidence.json"));

export function resolveUserPath(value, fallback) {
  return path.resolve(value || fallback);
}

export async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON file: ${filePath}`);
  }
}

export async function writeJsonExclusive(filePath, value, mode = 0o644) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(resolved, "wx", mode);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Refusing to overwrite existing file: ${resolved}`);
    throw new Error(`Could not write ${resolved}: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(resolved, mode).catch(() => {});
  return resolved;
}

export async function writeTextExclusive(filePath, text, mode = 0o644) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  let handle;
  try {
    handle = await open(resolved, "wx", mode);
    await handle.writeFile(String(text), "utf8");
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Refusing to overwrite existing file: ${resolved}`);
    throw new Error(`Could not write ${resolved}: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(resolved, mode).catch(() => {});
  return resolved;
}

export async function saveIdentityRecord(filePath, record) {
  return writeJsonExclusive(filePath, record, 0o600);
}

export async function loadIdentityRecord(filePath) {
  return readJson(filePath);
}

export async function saveEvidence(filePath, evidence) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await writeFile(resolved, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "w", mode: 0o600 });
  } catch (error) {
    throw new Error(`Could not update ${resolved}: ${error.message}`);
  }
  await chmod(resolved, 0o600).catch(() => {});
  return resolved;
}

export async function loadOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.message.startsWith("ENOENT")) return null;
    throw error;
  }
}
