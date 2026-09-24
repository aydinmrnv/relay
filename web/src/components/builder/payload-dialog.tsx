'use client';

import { useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { samplePayload } from '@/lib/workflow/simulate';
import type { Workflow } from '@/lib/workflow/schema';

interface Props {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (payload: Record<string, unknown>) => void;
}

/**
 * "Run with my own ticket": the trigger's payload as editable JSON. The
 * simulator routes on it exactly as it would on a real event, so this is how
 * to see what a condition does with a label, or a budget with a big estimate.
 */
export function PayloadDialog({ workflow, open, onOpenChange, onRun }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* Remounted per opening so it starts from the current sample, not last time's edits. */}
        {open ? <PayloadForm workflow={workflow} onCancel={() => onOpenChange(false)} onRun={onRun} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PayloadForm({ workflow, onCancel, onRun }: { workflow: Workflow; onCancel: () => void; onRun: (payload: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(samplePayload(workflow), null, 2));
  let error: string | null = null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) error = 'The payload must be a JSON object: { … }.';
    else parsed = value as Record<string, unknown>;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Not valid JSON.';
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Test run with your own payload</DialogTitle>
        <DialogDescription>
          This is what the trigger hands to the rest of the workflow. Change the title, labels or author to see how conditions and gates react. Fields are available as variables like {'{{issue.title}}'}.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label="Trigger payload as JSON" aria-invalid={error !== null} className="min-h-72 font-mono text-xs" />
        {error === null ? <p className="text-xs text-muted-foreground">Valid JSON.</p> : <p className="text-xs text-destructive">{error}</p>}
      </div>
      <DialogFooter className="gap-2">
        <Button variant="ghost" onClick={() => setText(JSON.stringify(samplePayload(workflow), null, 2))}>
          <RotateCcw data-icon="inline-start" /> Reset to sample
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={parsed === null} onClick={() => parsed !== null && onRun(parsed)}>
          <Play data-icon="inline-start" /> Run
        </Button>
      </DialogFooter>
    </>
  );
}
