'use client';

import { CheckCircle2, MessageSquareWarning } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RecordingFinding, RecordingResponse, RecordingReview } from '@/lib/replay/types';

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

function agentName(provider: string | undefined): string {
  if (provider === undefined) return 'the author';
  return AGENT_NAMES[provider] ?? provider;
}

const RESPONSE_STYLE: Record<string, string> = {
  ACCEPT: 'border-success/30 text-success',
  REJECT: 'border-destructive/30 text-destructive',
  NEEDS_CLARIFICATION: 'border-warning/40 text-amber-600 dark:text-warning',
};

/**
 * The two debates of a run, round by round: what the reviewer found, and what
 * the author answered to each finding. `agents` says who held which role, so
 * an answer is attributed to the model that gave it.
 */
export function ReviewsPanel({ reviews, agents }: { reviews: RecordingReview[]; agents: Record<string, string> }) {
  if (reviews.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No review has finished yet at this point in the run.</p>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {reviews.map((review) => {
        const author = agentName(review.kind === 'plan' ? agents['planner'] : agents['implementer']);
        return (
          <li key={`${review.kind}-${review.round}`} className="rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-4 py-3">
              {review.decision === 'approve' ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden /> : <MessageSquareWarning className="size-4 shrink-0 text-amber-600 dark:text-warning" aria-hidden />}
              <h3 className="text-sm font-medium">
                {review.kind === 'plan' ? 'Plan review' : 'Code review'}, round {review.round}
              </h3>
              <span className="text-sm text-muted-foreground">
                {agentName(review.reviewer)} read {author}’s {review.kind === 'plan' ? 'plan' : 'diff'}
              </span>
              <Badge variant={review.decision === 'approve' ? 'secondary' : 'outline'} className="ml-auto">
                {review.decision === 'approve' ? 'Approved' : 'Requested changes'}
              </Badge>
            </header>
            {review.summary === undefined ? null : <p className="border-b px-4 py-3 text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]">{review.summary}</p>}
            {review.findings.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No findings.</p>
            ) : (
              <ul className="divide-y">
                {review.findings.map((finding) => (
                  <li key={finding.id} className="px-4 py-3">
                    <Finding finding={finding} response={review.responses.find((response) => response.findingId === finding.id)} author={author} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Finding({ finding, response, author }: { finding: RecordingFinding; response: RecordingResponse | undefined; author: string }) {
  const where = finding.file === undefined ? null : `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-medium">{finding.id}</span>
        <Badge variant="outline" className="h-5 text-[10px]">
          {finding.severity} · {finding.category}
        </Badge>
        {finding.impact === undefined ? null : (
          <Badge variant={finding.impact === 'BLOCKING' ? 'destructive' : 'secondary'} className="h-5 text-[10px]">
            {finding.impact.toLowerCase().replace('_', '-')}
          </Badge>
        )}
        {where === null ? null : <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{where}</span>}
      </div>
      <p className="text-sm text-pretty [overflow-wrap:anywhere]">{finding.summary}</p>
      {finding.evidence === undefined && finding.suggestedFix === undefined ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">Evidence and suggested fix</summary>
          {finding.evidence === undefined ? null : <p className="mt-2 text-pretty whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{finding.evidence}</p>}
          {finding.suggestedFix === undefined ? null : (
            <p className="mt-2 text-pretty whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="font-medium">Suggested:</span> {finding.suggestedFix}
            </p>
          )}
        </details>
      )}
      {response === undefined ? null : (
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-sm">
          <span className={cn('mt-0.5 shrink-0 rounded-full border bg-background px-1.5 py-px text-[10px] font-semibold tracking-wide', RESPONSE_STYLE[response.response] ?? 'text-muted-foreground')}>{response.response.replace('_', ' ')}</span>
          <p className="min-w-0 text-pretty [overflow-wrap:anywhere]">
            <span className="font-medium">{author}:</span> {response.reasoning.length > 0 ? response.reasoning : 'No reason given.'}
          </p>
        </div>
      )}
    </div>
  );
}
