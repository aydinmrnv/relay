/**
 * Sealing app credentials before they reach the database: AES-256-GCM, with
 * the owner and the app as associated data, so a sealed value copied onto
 * another person's row, or another app's, fails to open rather than work.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../api';
import { CREDENTIALS_ENABLED, CREDENTIALS_KEY, CREDENTIALS_UNAVAILABLE_REASON, IS_PRODUCTION } from '../env';

const VERSION = 'v1';
const DEV_KEY_FILE = path.join('.data', 'credentials.key');

let devKey: Promise<Buffer> | null = null;

async function key(): Promise<Buffer> {
  if (!CREDENTIALS_ENABLED) throw new ApiError(503, 'CREDENTIALS_DISABLED', IS_PRODUCTION ? 'Real connections are not switched on for this server.' : (CREDENTIALS_UNAVAILABLE_REASON ?? 'Real connections are not switched on for this server.'));
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
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', await key(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(context(userId, connectorId));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * Keys this server used before, for rotating: `RELAY_CREDENTIALS_KEY_PREVIOUS`,
 * comma-separated, each 32 bytes of base64. New values are always sealed with
 * the current key; a stored one that only an older key opens still opens,
 * says so, and is sealed again the next time it is checked. Once every
 * connection has been checked since the change, the old key can be removed.
 */
const PREVIOUS_KEYS: Buffer[] = (process.env.RELAY_CREDENTIALS_KEY_PREVIOUS ?? '')
  .split(',')
  .map((raw) => Buffer.from(raw.trim(), 'base64'))
  .filter((candidate) => candidate.length === 32);

const IV_BYTES = 12;
const TAG_BYTES = 16;

function open(secret: Buffer, iv: Buffer, tag: Buffer, body: Buffer, userId: string, connectorId: string): string {
  // The tag's length is fixed here: GCM accepts shorter ones, and a 4-byte tag is one a forger can guess.
  const decipher = createDecipheriv('aes-256-gcm', secret, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(context(userId, connectorId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** The credential, and whether it took a retired key to open it. */
export async function unseal(sealed: string, userId: string, connectorId: string): Promise<{ value: string; stale: boolean }> {
  const [version, ivText, tagText, bodyText] = sealed.split('.');
  const unreadable = () => new ApiError(500, 'CREDENTIAL_UNREADABLE', 'The stored credential is in a format this server does not know. Connect the app again.');
  if (version !== VERSION || ivText === undefined || tagText === undefined || bodyText === undefined) throw unreadable();
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw unreadable();
  const body = Buffer.from(bodyText, 'base64url');
  const current = await key();
  try {
    return { value: open(current, iv, tag, body, userId, connectorId), stale: false };
  } catch {
    // Not the current key. One it was rotated from, perhaps.
  }
  for (const previous of PREVIOUS_KEYS) {
    try {
      return { value: open(previous, iv, tag, body, userId, connectorId), stale: true };
    } catch {
      // Not this one either.
    }
  }
  throw new ApiError(500, 'CREDENTIAL_UNREADABLE', 'The stored credential cannot be decrypted, most likely because the server’s key changed. Connect the app again.');
}
