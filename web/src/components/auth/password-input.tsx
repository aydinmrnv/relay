'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** A password field with a show/hide toggle, so a typo can be caught before submitting. */
export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input type={visible ? 'text' : 'password'} className={cn('pr-9', className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** How strong a new password is, on the checks that matter most, shown as the person types. */
export function PasswordChecklist({ password }: { password: string }) {
  const checks = [
    { ok: password.length >= 8, label: '8+ characters' },
    { ok: /[a-zA-Z]/.test(password) && /[0-9]/.test(password), label: 'letters and numbers' },
    { ok: password.length >= 12 || /[^a-zA-Z0-9]/.test(password), label: '12+ or a symbol' },
  ];
  const score = checks.filter((check) => check.ok).length;
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span key={index} className={cn('h-1 flex-1 rounded-full bg-muted transition-colors', index < score && (score === 1 ? 'bg-destructive/70' : score === 2 ? 'bg-warning' : 'bg-success'))} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {checks.map((check) => (
          <li key={check.label} className={cn(check.ok && 'text-foreground')}>
            {check.ok ? '✓' : '·'} {check.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
