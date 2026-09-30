/**
 * Sealing app credentials before they reach the database: AES-256-GCM, with
 * the owner and the app as associated data, so a sealed value copied onto
 * another person's row, or another app's, fails to open rather than work.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../api';
import { CREDENTIALS_ENABLED, CREDENTIALS_KEY, CREDENTIALS_UNAVAILABLE_REASON } from '../env';

const VERSION = 'v1';
const DEV_KEY_FILE = path.join('.data', 'credentials.key');

let devKey: Promise<Buffer> | null = null;

async function key(): Promise<Buffer> {
  if (!CREDENTIALS_ENABLED) throw new ApiError(503, 'CREDENTIALS_DISABLED', CREDENTIALS_UNAVAILABLE_REASON ?? 'Real connections are not switched on for this server.');
  if (CREDENTIALS_KEY !== null) return CREDENTIALS_KEY;
  devKey ??= loadDevKey().catch((error: unknown) => {
    devKey = null;
    throw error;
  });
  return devKey;
}

/** Development only: one key per checkout, made on first use. Deleting it makes stored connections unreadable. */
async function loadDevKey(): Promise<Buffer> {
  const existing = await readDevKey();
  if (existing !== null) return existing;
  await mkdir(path.dirname(DEV_KEY_FILE), { recursive: true });
  try {
    await writeFile(DEV_KEY_FILE, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another request made it first: use theirs.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const made = await readDevKey();
  if (made === null) throw new Error(`Could not read ${DEV_KEY_FILE}.`);
  return made;
}

async function readDevKey(): Promise<Buffer | null> {
  try {
    const key = Buffer.from((await readFile(DEV_KEY_FILE, 'utf8')).trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function context(userId: string, connectorId: string): Buffer {
  return Buffer.from(`${userId}\n${connectorId}`, 'utf8');
}

export async function seal(plaintext: string, userId: string, connectorId: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(), iv);
  cipher.setAAD(context(userId, connectorId));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export async function unseal(sealed: string, userId: string, connectorId: string): Promise<string> {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || iv === undefined || tag === undefined || body === undefined) throw new ApiError(500, 'CREDENTIAL_UNREADABLE', 'The stored credential is in a format this server does not know. Connect the app again.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(context(userId, connectorId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'CREDENTIAL_UNREADABLE', 'The stored credential cannot be decrypted, most likely because the server’s key changed. Connect the app again.');
  }
}
