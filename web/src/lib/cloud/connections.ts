'use client';

/**
 * The browser's side of connecting an app for real. The credential goes to
 * the studio's server once, to be checked and sealed; what comes back, and
 * what the store keeps, is a `Connection` with a summary and never the
 * credential itself.
 */
import { useStudio } from '@/lib/store';
import type { Connection } from '@/lib/workflow/schema';
import { api, CloudError } from './sync';

function path(connectorId: string, action?: 'check' | 'test'): string {
  return `/api/connections/${encodeURIComponent(connectorId)}${action === undefined ? '' : `/${action}`}`;
}

function headers(): Record<string, string> {
  const owner = useStudio.getState().owner;
  return owner === null ? {} : { 'x-relay-user': owner };
}

/** Keeps what the server said about a connection, including a failing one. */
function keep(connection: Connection): Connection {
  useStudio.getState().setConnection(connection);
  return connection;
}

export async function connectForReal(connectorId: string, secret: string, label: string): Promise<Connection> {
  const body = label.trim().length > 0 ? { secret, label: label.trim() } : { secret };
  const { connection } = await api<{ connection: Connection }>(path(connectorId), { method: 'PUT', body, headers: headers() });
  return keep(connection);
}

export async function checkConnection(connectorId: string): Promise<Connection> {
  const { connection } = await api<{ connection: Connection }>(path(connectorId, 'check'), { method: 'POST', headers: headers() });
  return keep(connection);
}

export async function sendTestMessage(connectorId: string): Promise<Connection> {
  try {
    const { connection } = await api<{ connection: Connection }>(path(connectorId, 'test'), { method: 'POST', headers: headers() });
    return keep(connection);
  } catch (error) {
    // Refused: the server marked the connection failing and says how it looks now.
    if (error instanceof CloudError && typeof error.data['connection'] === 'object' && error.data['connection'] !== null) keep(error.data['connection'] as Connection);
    throw error;
  }
}

/** Deletes the credential on the server, then forgets the connection here. */
export async function disconnectForReal(connectorId: string): Promise<void> {
  await api<{ ok: boolean }>(path(connectorId), { method: 'DELETE', headers: headers() });
  useStudio.getState().disconnect(connectorId);
}
