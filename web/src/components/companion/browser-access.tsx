'use client';

import { ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Chrome, Edge and Brave ask before a website may reach a service on the
 * person's own computer ("Local network access"), and `relay connect` is one.
 * These say what the question is, before and after it is answered.
 */

/** While the browser's question is on screen. */
export function AllowAccessNotice({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border border-signal/30 bg-signal/5 p-3 text-sm', className)}>
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium">Choose Allow in your browser</p>
        <p className="text-xs text-pretty text-muted-foreground">
          Your browser is asking whether this site may reach apps and services on this device. That is relay connect, answering on 127.0.0.1 only, and only to the token from your terminal. You are asked once per site.
        </p>
      </div>
    </div>
  );
}

/** After the browser has been told no: how to take it back. It connects by itself once allowed. */
export function BlockedAccessHelp({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-2 text-sm', className)}>
      <ol className="grid gap-1.5 text-pretty">
        <li className="flex gap-2">
          <Num n={1} />
          <span>
            Click the <SlidersHorizontal className="inline size-3.5 align-[-2px]" aria-label="site controls" /> icon at the left end of the address bar.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={2} />
          <span>
            Turn on <span className="font-medium">Local network access</span> for this site (some versions call it <span className="font-medium">Apps on device</span>). If it is not listed, open Site settings from there.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={3} />
          <span>Come back to this tab: the studio connects once it is allowed. If it does not, reload the page.</span>
        </li>
      </ol>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{n}</span>;
}
