'use client';

import { CheckCircle2, CircleHelp, Gauge, XCircle } from 'lucide-react';
import { HelpTip } from '@/components/app/help-tip';
import { cn } from '@/lib/utils';
import type { Receipt, ReceiptSide, ReceiptVerdict } from '@/lib/replay/types';

const VERDICT: Record<ReceiptVerdict, { label: string; counted: string; meaning: string; icon: React.ReactNode; tone: string; ring: string }> = {
  match: { label: 'Agrees', counted: 'agree', meaning: 'The claim and the measurement agree.', icon: <CheckCircle2 className="size-4" />, tone: 'text-success', ring: 'border-success/30' },
  mismatch: { label: 'Disagrees', counted: 'disagree', meaning: 'The claim and the measurement do not agree.', icon: <XCircle className="size-4" />, tone: 'text-destructive', ring: 'border-destructive/40 bg-destructive/5' },
  measured: { label: 'Measured', counted: 'measured only', meaning: 'Relay measured it, and nobody claimed anything to compare it with.', icon: <Gauge className="size-4" />, tone: 'text-muted-foreground', ring: 'border-border' },
  unverified: { label: 'Unverified', counted: 'unverified', meaning: 'Something was claimed or expected, and the run holds nothing that settles it.', icon: <CircleHelp className="size-4" />, tone: 'text-amber-600 dark:text-warning', ring: 'border-warning/40 bg-warning/5' },
};

const ORDER: readonly ReceiptVerdict[] = ['match', 'mismatch', 'measured', 'unverified'];

/**
 * What was said about the run beside what was measured, one row per check.
 * `shown` is how many of them the replay has reached; the rest are counted,
 * not drawn, so scrubbing back never shows a result before its time.
 */
export function ReceiptsPanel({ receipts, shown }: { receipts: Receipt[]; shown: number }) {
  const known = receipts.slice(0, shown);
  const counts = ORDER.map((verdict) => ({ verdict, count: known.filter((receipt) => receipt.verdict === verdict).length })).filter((entry) => entry.count > 0);
  const waiting = receipts.length - known.length;

  if (receipts.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">This recording carries no receipts. It was made before the export wrote them, or the run ended before anything could be measured.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <span className="flex items-center gap-1.5 font-medium">
          Receipts
          <HelpTip title="Receipts">
            Each row is a check the run already made, written down: what somebody claimed, what Relay measured, and where each came from. Nothing here is re-run or estimated. A row with no claim to compare says “measured”; a row with nothing measured says “unverified”.
          </HelpTip>
        </span>
        {counts.map(({ verdict, count }) => (
          <span key={verdict} className={cn('inline-flex items-center gap-1 text-xs', VERDICT[verdict].tone)} title={VERDICT[verdict].meaning}>
            {VERDICT[verdict].icon}
            <span className="tabular-nums">{count}</span> {VERDICT[verdict].counted}
          </span>
        ))}
        {waiting > 0 ? <span className="text-xs text-muted-foreground">{waiting} not known yet at this point in the run</span> : null}
      </div>
      {known.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Nothing has been measured yet at this point in the run. Move the scrubber forwards.</p> : null}
      <ol className="flex flex-col gap-2.5">
        {known.map((receipt) => (
          <li key={receipt.id}>
            <ReceiptRow receipt={receipt} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const verdict = VERDICT[receipt.verdict];
  return (
    <article className={cn('rounded-xl border bg-card p-3.5', verdict.ring)}>
      <header className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 shrink-0', verdict.tone)} aria-hidden>
          {verdict.icon}
        </span>
        <h3 className="min-w-0 flex-1 text-sm font-medium text-pretty">{receipt.subject}</h3>
        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', verdict.tone)} title={verdict.meaning}>
          {verdict.label}
        </span>
      </header>
      <dl className="mt-2.5 grid gap-x-3 gap-y-2 pl-6.5 text-sm sm:grid-cols-[5.5rem_1fr]">
        <Side label="Claimed" side={receipt.claim} empty="Nobody claimed anything about this." />
        <Side label="Measured" side={receipt.measured} empty="The run holds no measurement of this." />
      </dl>
      {receipt.note === undefined ? null : <p className="mt-2.5 pl-6.5 text-xs text-pretty text-muted-foreground">{receipt.note}</p>}
    </article>
  );
}

function Side({ label, side, empty }: { label: string; side: ReceiptSide | null; empty: string }) {
  return (
    <>
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase sm:pt-0.5">{label}</dt>
      <dd className="min-w-0">
        {side === null ? (
          <span className="text-muted-foreground">{empty}</span>
        ) : (
          <>
            <p className="text-pretty [overflow-wrap:anywhere]">
              <span className="font-medium">{side.by}:</span> {side.text}
            </p>
            {side.source.length > 0 ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{side.source}</p> : null}
          </>
        )}
      </dd>
    </>
  );
}
