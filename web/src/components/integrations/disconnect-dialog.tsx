'use client';

import { Unplug } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Connector } from '@/lib/connectors';
import { credentialSpec } from '@/lib/connectors/credentials';

/**
 * Confirms before a real connection goes: unlike a marker, it cannot be
 * undone from a toast, because the studio deletes the only copy it had.
 */
export function DisconnectDialog({ connector, open, onOpenChange, onConfirm }: { connector: Connector; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  // "The incoming webhook", "the personal API key": what it is called in the app, where it has to be removed.
  const thing = credentialSpec(connector.id)?.noun.replace(/^an? /, '') ?? 'credential';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Unplug />
          </AlertDialogMedia>
          <AlertDialogTitle>Disconnect {connector.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The studio deletes its encrypted copy, and {connector.name} steps ask to be connected again. To connect later you paste it anew. The {thing} itself keeps working in {connector.name} until you remove it there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
