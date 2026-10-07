'use client';

import { useRef, useState } from 'react';
import { Download, RotateCcw, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { useImportFlow } from '@/components/workflows/import-flow';
import { useAccount } from '@/lib/cloud/account';
import { api } from '@/lib/cloud/sync';
import { SettingBlock } from './settings-section';

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Backup, restore and start over. `onReplaced` lets the page remount its
 * drafts (the name field, the repository field) after an import or a reset
 * changed what they were seeded from.
 */
export function DataSettings({ onReplaced }: { onReplaced: () => void }) {
  const brand = useBrand();
  const workflowCount = useStudio((state) => Object.keys(state.workflows).length);
  const runCount = useStudio((state) => state.runs.length);
  const connectionCount = useStudio((state) => Object.keys(state.connections).length);
  const realConnectionCount = useStudio((state) => Object.values(state.connections).filter((connection) => connection.credential !== undefined).length);
  const owner = useStudio((state) => state.owner);
  const exportAll = useStudio((state) => state.exportAll);
  const resetAll = useStudio((state) => state.resetAll);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const fileName = `${brand.slug}-studio-export.json`;

  const download = () => {
    const blob = new Blob([exportAll()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    // Not at once: some browsers start the download after this task, and a revoked URL saves nothing.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.success(`Downloaded ${fileName}`, { description: `${plural(workflowCount, 'workflow')}, ${plural(runCount, 'run')} and ${plural(connectionCount, 'connection')}.` });
  };

  const { importFile, dialog: importDialog } = useImportFlow(onReplaced);

  const onImport = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // Clear the input so choosing the same file again still fires a change.
    input.value = '';
    await importFile(file);
  };

  const [clearing, setClearing] = useState(false);

  const reset = async () => {
    if (signedIn && realConnectionCount > 0) {
      // The credentials themselves are on the server, not in this browser:
      // unless they are deleted there first, they come back on the next load.
      setClearing(true);
      try {
        await api('/api/connections', { method: 'DELETE', headers: owner === null ? {} : { 'x-relay-user': owner } });
      } catch (error) {
        setClearing(false);
        toast.error('Nothing was cleared', { description: `The stored app credentials could not be deleted${error instanceof Error ? `: ${error.message}` : '.'} Try again when the server is reachable.` });
        return;
      }
      setClearing(false);
    }
    setConfirming(false);
    resetAll();
    onReplaced();
    toast.success(signedIn ? 'Cleared. Your account is empty and ready for a fresh start.' : 'Reset. The starter workflows and demo runs are being recreated.');
  };

  return (
    <Card className="gap-0 py-0">
      <SettingBlock
        title="Export everything"
        description={`One JSON file with your ${plural(workflowCount, 'workflow')}, ${plural(runCount, 'run')}, ${plural(connectionCount, 'connection')}, and your settings. Secret fields are left out: they stay in the browser they were typed in. Keep it as a backup, or import it in another browser.`}
      >
        <div>
          <Button variant="outline" onClick={download}>
            <Download data-icon="inline-start" /> Download {fileName}
          </Button>
        </div>
      </SettingBlock>
      <Separator />
      <SettingBlock
        title="Import"
        description="Takes a full export from here, or a single workflow file from Export in the builder. A full export adds the workflows and runs you do not have, and asks before replacing a workflow that is already here. A single workflow is added next to yours. Nothing of yours is removed, and your settings stay as they are."
      >
        <div>
          <Button variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload data-icon="inline-start" /> Choose a file…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Import a studio export or a workflow file"
            onChange={(event) => void onImport(event.currentTarget)}
          />
          {importDialog}
        </div>
      </SettingBlock>
      <Separator />
      <SettingBlock
        className="bg-destructive/[0.03] dark:bg-destructive/[0.06]"
        title={signedIn ? 'Clear your workspace' : 'Reset demo data'}
        description={
          signedIn
            ? 'Deletes every workflow, run and connection in your account and resets your settings. Your account itself stays; to delete it, see Account above.'
            : 'Deletes everything the studio keeps in this browser, then recreates the starter workflows and demo runs, as on a first visit.'
        }
      >
        <div>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogTrigger render={<Button variant="destructive" />}>
              <RotateCcw data-icon="inline-start" /> {signedIn ? 'Clear workspace…' : 'Reset demo data…'}
            </AlertDialogTrigger>
            <AlertDialogContent className="data-[size=default]:sm:max-w-md">
              <AlertDialogHeader>
                <AlertDialogMedia className="bg-destructive/10 text-destructive">
                  <TriangleAlert />
                </AlertDialogMedia>
                <AlertDialogTitle>{signedIn ? 'Clear everything in your account?' : 'Reset everything in this browser?'}</AlertDialogTitle>
                <AlertDialogDescription render={<div />} className="grid gap-2 text-left">
                  <p>This permanently deletes:</p>
                  <ul className="grid gap-1 pl-4 [&>li]:list-disc">
                    <li>{plural(workflowCount, 'workflow')}, including any you built or changed</li>
                    <li>{plural(runCount, 'run')} and their timelines</li>
                    <li>
                      {plural(connectionCount, 'app connection')}
                      {realConnectionCount > 0 ? `, including the ${realConnectionCount === 1 ? 'credential' : `${realConnectionCount} credentials`} stored encrypted for ${realConnectionCount === 1 ? 'it' : 'them'} (still valid in the app until you remove ${realConnectionCount === 1 ? 'it' : 'them'} there)` : ''}
                    </li>
                    <li>
                      your settings: credentials, default repository, playback speed and
                      animations
                    </li>
                    <li>which tours and checklist steps you have dismissed</li>
                  </ul>
                  <p>There is no undo. Your theme and your coding agents’ sign-ins are not touched; the sign-ins live in the CLIs.</p>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button variant="outline" onClick={download}>
                  <Download data-icon="inline-start" /> Export first
                </Button>
                <Button variant="destructive" onClick={() => void reset()} disabled={clearing}>
                  {signedIn ? 'Clear everything' : 'Reset everything'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SettingBlock>
    </Card>
  );
}
