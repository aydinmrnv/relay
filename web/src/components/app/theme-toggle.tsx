'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const subscribe = () => () => undefined;

/**
 * Light or dark, for the pages outside the studio: the site, the legal pages,
 * sign-in and shared workflows. The studio's header has its own switch; a
 * visitor who has not signed in had no way to choose at all.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // The theme is only known in the browser; until then the button keeps its place and shows neither icon.
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const dark = mounted && resolvedTheme === 'dark';
  const label = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  return (
    <Button variant="ghost" size="icon" className={cn('rounded-full', className)} aria-label={label} title={label} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {mounted ? dark ? <Sun /> : <Moon /> : <span className="size-4" aria-hidden />}
    </Button>
  );
}
