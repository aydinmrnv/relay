'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { motion } from 'motion/react';
import { Gauge, Monitor, Moon, Sparkles, Sun, Timer, Waves, Zap } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { HelpTip } from '@/components/app/help-tip';
import { useStudio } from '@/lib/store';
import type { Settings } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { ChoiceCards, SettingBlock } from './settings-section';

type ThemeChoice = 'light' | 'dark' | 'system';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduce(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The operating system's reduce-motion setting, live. Only used to say what "System" currently means. */
function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE_QUERY).matches, () => false);
}

export function AppearanceSettings() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const motionPreference = useStudio((state) => state.settings.motion);
  const speed = useStudio((state) => state.settings.simulationSpeed);
  const updateSettings = useStudio((state) => state.updateSettings);
  const systemReduces = useSystemReducedMotion();
  const current = (theme === 'light' || theme === 'dark' ? theme : 'system') satisfies ThemeChoice;
  const animationsOn = motionPreference === 'full' || (motionPreference === 'system' && !systemReduces);

  return (
    <Card className="gap-0 py-0">
      <SettingBlock title="Theme" description="Colours for the whole studio, the canvas included. Saved in this browser.">
        <ChoiceCards<ThemeChoice>
          name="theme"
          label="Theme"
          value={current}
          onValueChange={setTheme}
          options={[
            { value: 'light', title: 'Light', icon: Sun, preview: <ThemeSwatch mode="light" />, description: 'Always light, whatever the time of day.' },
            { value: 'dark', title: 'Dark', icon: Moon, preview: <ThemeSwatch mode="dark" />, description: 'Always dark. Easier on the eyes at night.' },
            {
              value: 'system',
              title: 'System',
              icon: Monitor,
              preview: <ThemeSwatch mode="system" />,
              description: `Follows your operating system and switches when it does.${current === 'system' && resolvedTheme !== undefined ? ` Currently ${resolvedTheme}.` : ''}`,
            },
          ]}
        />
      </SettingBlock>
      <Separator />
      <SettingBlock
        title="Animations"
        description="Page transitions, cards arriving in turn, and the canvas lighting up during a test run."
        aside={<MotionPreview on={animationsOn} />}
      >
        <ChoiceCards<Settings['motion']>
          name="motion"
          label="Animations"
          value={motionPreference}
          onValueChange={(value) => updateSettings({ motion: value })}
          options={[
            {
              value: 'system',
              title: 'System',
              icon: Monitor,
              description: `Follows your operating system’s reduce-motion setting, which is ${systemReduces ? 'on, so movement is kept to fades' : 'off, so everything animates'}.`,
            },
            { value: 'full', title: 'Full', icon: Sparkles, description: 'Every animation plays, even if your operating system asks for less motion.' },
            { value: 'reduced', title: 'Reduced', icon: Waves, description: 'Animations are skipped: content appears where it ends up, without sliding or springing. Loading spinners still turn.' },
          ]}
        />
      </SettingBlock>
      <Separator />
      <SettingBlock
        title={
          <span className="inline-flex items-center gap-1.5">
            Test-run playback <HelpTip term="test-run" />
          </span>
        }
        description="How fast a test run plays back in the builder. The recorded timeline and costs are the same at every speed."
      >
        <ChoiceCards<Settings['simulationSpeed']>
          name="speed"
          label="Test-run playback speed"
          value={speed}
          onValueChange={(value) => updateSettings({ simulationSpeed: value })}
          options={[
            { value: 'instant', title: 'Instant', icon: Zap, description: 'The whole run is recorded at once. Open it to read the timeline.' },
            { value: 'fast', title: 'Fast', icon: Gauge, description: 'Plays in a few seconds, so you can watch each node light up in turn.' },
            { value: 'realistic', title: 'Realistic', icon: Timer, description: 'Around ten seconds, with each phase paced like a real run, which takes 10 to 30 minutes.' },
          ]}
        />
      </SettingBlock>
    </Card>
  );
}

/** A tiny picture of the studio in each theme. Drawn with fixed colours on purpose: it shows the other theme, not the current one. */
function ThemeSwatch({ mode }: { mode: ThemeChoice }) {
  const light = <Window className="bg-white" sidebar="bg-zinc-100" line="bg-zinc-200" accent="bg-violet-500" />;
  const dark = <Window className="bg-zinc-950" sidebar="bg-zinc-900" line="bg-zinc-800" accent="bg-violet-400" />;
  return (
    <span className="relative mb-1 block h-16 w-full overflow-hidden rounded-md border" aria-hidden>
      {mode === 'dark' ? dark : light}
      {mode === 'system' ? <span className="absolute inset-0 [clip-path:polygon(55%_0,100%_0,100%_100%,45%_100%)]">{dark}</span> : null}
    </span>
  );
}

function Window({ className, sidebar, line, accent }: { className: string; sidebar: string; line: string; accent: string }) {
  return (
    <span className={cn('absolute inset-0 flex', className)}>
      <span className={cn('w-1/4', sidebar)} />
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className={cn('h-1.5 w-1/2 rounded-full', line)} />
        <span className={cn('h-1.5 w-3/4 rounded-full', line)} />
        <span className="mt-auto flex gap-1">
          <span className={cn('h-2.5 w-6 rounded-sm', accent)} />
          <span className={cn('h-2.5 w-4 rounded-sm', line)} />
        </span>
      </span>
    </span>
  );
}

/** A dot that glides back and forth while animations are on, and sits still when they are off. */
function MotionPreview({ on }: { on: boolean }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <span className="relative h-5 w-16 rounded-full border bg-muted/50" aria-hidden>
        <motion.span
          className="absolute top-1/2 left-1 size-3 -translate-y-1/2 rounded-full bg-primary"
          animate={on ? { x: [0, 40, 0] } : { x: 20 }}
          transition={on ? { duration: 1.8, ease: 'easeInOut', repeat: Infinity } : { duration: 0 }}
        />
      </span>
      {on ? 'Animations on' : 'Animations off'}
    </span>
  );
}
