'use client';

import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Info, Lightbulb, WandSparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/textarea';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { GraphThumbnail } from '@/components/templates/graph-thumbnail';
import { useBrand } from '@/hooks/use-brand';
import { getNodeType } from '@/lib/connectors';
import { useStudio } from '@/lib/store';
import { DESCRIPTION_EXAMPLES, workflowFromDescription, type DescribedStep, type DescriptionResult } from '@/lib/workflow/from-description';
import { cn } from '@/lib/utils';

interface ComposerProps {
  value: string;
  /** Every edit, with the workflow the text describes; `null` while it is blank. */
  onChange: (text: string, result: DescriptionResult | null) => void;
  /** The repository new workflows attach to. */
  repository?: string;
  autoFocus?: boolean;
  className?: string;
  /** ⌘/Ctrl+Enter in the text box. */
  onSubmit?: () => void;
  /** The graph sketch. Turn it off where the page already previews the workflow beside the composer. */
  showPreview?: boolean;
}

const PLACEHOLDER = 'When a Linear issue is assigned to the bot, fix it under $5, open a draft PR and tell Slack #eng.';

const KIND_NAMES: Record<DescribedStep['kind'], string> = {
  trigger: 'Starts with',
  guardrail: 'Guardrail',
  logic: 'Logic',
  pipeline: 'Agents',
  delivery: 'Delivery',
  notify: 'Tells',
  action: 'Then',
};

/**
 * One sentence in, a workflow out, as you type. The reading is deterministic
 * and happens in the browser (`workflowFromDescription`), so the preview is
 * instant, free and private. Controlled: the parent owns the text and gets the
 * resulting workflow with every change, ready to save.
 */
export function DescribeWorkflowComposer({ value, onChange, repository, autoFocus = false, className, onSubmit, showPreview = true }: ComposerProps) {
  const brand = useBrand();
  const inputId = useId();
  const hintId = useId();
  // The parent gets a fresh result on every keystroke; only the drawing waits for a pause, so the graph does not flicker mid-word.
  const settled = useDebounced(value, 150);
  const preview = useMemo(() => (settled.trim() === '' ? null : workflowFromDescription(settled, brand, repository)), [settled, brand, repository]);
  const examples = useMemo(() => DESCRIPTION_EXAMPLES.map((text) => ({ text, label: workflowFromDescription(text, brand, repository).workflow.name })), [brand, repository]);
  const blank = value.trim() === '';
  const shown = blank ? null : preview;

  const change = (text: string) => onChange(text, text.trim() === '' ? null : workflowFromDescription(text, brand, repository));
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          What should happen?
        </label>
        <Textarea
          id={inputId}
          value={value}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          rows={3}
          placeholder={PLACEHOLDER}
          aria-describedby={hintId}
          spellCheck
          className="min-h-24 resize-none leading-relaxed"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          Say what starts it, what the agents do, how far the change goes and who hears about it. Read in your browser: no model, no API key.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Examples">
        <span className="text-xs text-muted-foreground">Try</span>
        {examples.map((example) => (
          <button
            key={example.text}
            type="button"
            onClick={() => change(example.text)}
            title={example.text}
            aria-label={`Use the example: ${example.text}`}
            className={cn(
              'max-w-[16rem] truncate rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              value === example.text ? 'border-foreground/30 bg-muted text-foreground' : 'bg-background',
            )}
          >
            {example.label}
          </button>
        ))}
      </div>

      {shown === null ? <EmptyState compact={!showPreview} /> : <Understood result={shown} showPreview={showPreview} />}

      <p className="sr-only" aria-live="polite">
        {shown === null ? '' : `${shown.workflow.name}: ${shown.steps.length} steps.${shown.unmatched.length > 0 ? ` Not understood: ${shown.unmatched.join(', ')}.` : ''}`}
      </p>
    </div>
  );
}

function EmptyState({ compact }: { compact: boolean }) {
  if (compact) return null;
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center">
      <WandSparkles className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">The workflow draws itself as you type</p>
      <p className="max-w-sm text-xs text-pretty text-muted-foreground">Start with “When…”, “Every weeknight…” or just the task, or pick an example above.</p>
    </div>
  );
}

function Understood({ result, showPreview }: { result: DescriptionResult; showPreview: boolean }) {
  return (
    <section aria-label="What was understood" className="flex flex-col gap-3 rounded-xl border bg-card/50 p-3">
      {showPreview ? <GraphThumbnail workflow={result.workflow} className="h-32 sm:h-36" /> : null}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium" title={result.workflow.name}>
          {result.workflow.name}
        </p>
        <Confidence value={result.confidence} />
      </div>
      <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
        {result.steps.map((step, index) => (
          <li key={`${step.typeId}-${index}`} className="min-w-0 max-w-full">
            <StepChip step={step} />
          </li>
        ))}
      </ol>
      {result.unmatched.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="text-pretty">
            Didn’t place {result.unmatched.map((phrase) => `“${phrase}”`).join(', ')}. Try naming an app, a budget (“under $5”), who may start it (“only from alice”) or where the change goes (“a draft PR”).
          </span>
        </p>
      ) : null}
      {result.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
          {result.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="text-pretty">{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function StepChip({ step }: { step: DescribedStep }) {
  const def = getNodeType(step.typeId);
  const [head, ...rest] = step.label.split(' · ');
  return (
    <span
      title={step.label}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-1.5 py-0.5 text-xs',
        // Amber, like the "Trigger" label on builder nodes and the thumbnail's first node.
        step.kind === 'trigger' ? 'border-amber-500/60 dark:border-amber-400/60' : '',
      )}
    >
      {def === undefined ? null : <ConnectorIcon connector={def.connector} size={12} variant="mark" className="shrink-0" />}
      <span className="sr-only">{KIND_NAMES[step.kind]}: </span>
      <span className="shrink-0 font-medium">{head}</span>
      {rest.length > 0 ? <span className="min-w-0 truncate text-muted-foreground">{rest.join(' · ')}</span> : null}
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  const [label, tone] =
    value >= 0.8 ? ['Understood', 'bg-emerald-500'] : value >= 0.5 ? ['Mostly understood', 'bg-amber-500'] : value > 0 ? ['Partly understood', 'bg-amber-500'] : ['A starting point', 'bg-muted-foreground/50'];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${Math.round(value * 100)}% of the sentence was understood`}>
      <span className={cn('size-1.5 rounded-full', tone)} aria-hidden />
      {label}
    </span>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Describe it": the composer in a dialog, and a button that saves the result and opens it in the builder. */
export function DescribeWorkflowDialog({ open, onOpenChange }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {/* Remounted on every open (the popup unmounts when closed), so each visit starts blank. */}
        <DescribeDialogBody onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DescribeDialogBody({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const brand = useBrand();
  const repository = useStudio((state) => state.settings.defaultRepository);
  const isMac = useIsMac();
  const [text, setText] = useState('');
  const blank = text.trim() === '';

  const create = () => {
    if (blank) return;
    // Read again from the text as it stands, rather than from a preview that may be a keystroke behind.
    const { workflow, steps } = workflowFromDescription(text, brand, repository);
    useStudio.getState().upsertWorkflow(workflow);
    toast.success(`Created “${workflow.name}”`, { description: `${steps.length} steps, switched off until you turn it on. Check each step’s settings first.` });
    onDone();
    router.push(`/workflows/${workflow.id}`);
  };

  return (
    <>
      <div className="flex flex-col gap-1.5 border-b p-5 pr-12">
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <WandSparkles className="size-4" aria-hidden /> Describe it
        </DialogTitle>
        <DialogDescription className="text-pretty">One sentence in, a whole workflow out. It is read right here in your browser: no AI model, no API key, nothing sent anywhere.</DialogDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <DescribeWorkflowComposer value={text} onChange={(next) => setText(next)} repository={repository} autoFocus onSubmit={create} />
      </div>
      <div className="flex flex-col-reverse gap-2 border-t bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-end">
        <p className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <KbdGroup>
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>Enter</Kbd>
          </KbdGroup>
          to create. It opens in the builder, switched off.
        </p>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button onClick={create} disabled={blank}>
          Create workflow <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

const subscribeToNothing = () => () => undefined;

/** The platform never changes under a page, so there is nothing to subscribe to; the server snapshot keeps hydration honest. */
function useIsMac(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => /Mac|iPhone|iPad/.test(navigator.userAgent), () => false);
}
