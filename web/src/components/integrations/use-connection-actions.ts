'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { checkConnection, disconnectForReal, sendTestMessage } from '@/lib/cloud/connections';
import type { Connector } from '@/lib/connectors';
import { useStudio } from '@/lib/store';

export type ConnectionAction = 'check' | 'test' | 'disconnect';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Check again, send a test message, disconnect: each says what happened in a
 * toast, and `busy` tells the buttons which one is still waiting.
 */
export function useConnectionActions() {
  const [busy, setBusy] = useState<ConnectionAction | null>(null);

  const guard = async (action: ConnectionAction, work: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(action);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };

  const check = (connector: Connector) =>
    guard('check', async () => {
      try {
        const connection = await checkConnection(connector.id);
        if (connection.status === 'error') toast.error(`${connector.name} refused the connection`, { description: connection.credential?.error });
        else toast.success(`${connector.name} still accepts it`, { description: 'Checked just now. Nothing was posted or changed.' });
      } catch (error) {
        toast.error(`Could not check ${connector.name}`, { description: message(error) });
      }
    });

  const test = (connector: Connector) =>
    guard('test', async () => {
      try {
        const connection = await sendTestMessage(connector.id);
        toast.success('Test message sent', { description: `Look for it in ${connection.account}.` });
      } catch (error) {
        toast.error(`${connector.name} did not take the test message`, { description: message(error) });
      }
    });

  const disconnect = (connector: Connector) =>
    guard('disconnect', async () => {
      const connection = useStudio.getState().connections[connector.id];
      try {
        if (connection?.credential === undefined) useStudio.getState().disconnect(connector.id);
        else await disconnectForReal(connector.id);
        toast(`Disconnected ${connector.name}`, {
          description: connection?.credential === undefined ? undefined : `The studio deleted its copy. It still works in ${connector.name} until you remove it there.`,
        });
      } catch (error) {
        toast.error(`Could not disconnect ${connector.name}`, { description: message(error) });
      }
    });

  return { busy, check, test, disconnect };
}
