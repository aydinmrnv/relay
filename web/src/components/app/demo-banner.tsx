'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useActiveProject, useNeedsInstall, useProjects } from '@/hooks/use-projects';
import { HOSTED_DEMO } from '@/lib/hosted';
import { useCompanion } from '@/lib/companion/client';
import { useAccount } from '@/lib/cloud/account';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * One line at the top of the studio with the single most useful next step:
 * make an account (the studio needs one), connect a repository, or — once
 * there is a project — finish what stands between it and a real run. While
 * that is unfinished a run here is a test run, and the line says so.
 */
export function DemoBanner({ className }: { className?: string }) {
  const connected = useCompanion((state) => state.status === 'connected');
  const status = useAccount((state) => state.status);
  const onboarded = useAccount((state) => state.onboardedAt !== null);
  const hydrated = useStudio((state) => state.hydrated);
  const projects = useProjects();
  const active = useActiveProject();
  const needsInstall = useNeedsInstall(active ?? projects[0]);

  if (status === 'guest') return <Line className={className} dot="Not signed in" text="Make a free account to build, test and run workflows." href="/sign-in" action="Sign in" />;
  // Until the saved studio is read there is no telling what is set up, and a line that flashes and goes is worse than none.
  if (!hydrated || status === 'unknown' || status === 'loading') return null;

  const project = active ?? projects[0];
  if (project === undefined) {
    return (
      <Line
        className={className}
        dot="Start here"
        text="Connect a repository and build its first workflow. About two minutes."
        href={status === 'signed-in' && !onboarded ? '/onboarding' : '/projects/new'}
        action="Set up your first project"
      />
    );
  }
  // With a runner connected a run here can be a real one, whatever the project says about where it runs.
  if (connected) return null;
  if (project.runner === 'actions') {
    // A project nobody set up, from before there were projects, is not told it is missing something.
    if (!needsInstall) return null;
    return <Line className={className} dot="Not installed yet" text={`Until ${project.repository} has its files, a run here is a test run, played back in your browser.`} href="/projects" action="Install it" />;
  }
  // On a build served from somebody's own computer the runner is a terminal away, and the sidebar already says where it stands.
  if (!HOSTED_DEMO) return null;
  return (
    <Line
      className={className}
      dot="Test runs only"
      text={project.runner === 'cloud' ? 'Your Relay Cloud machine is not set up yet, so a run here is played back in your browser.' : 'Your computer is not connected, so a run here is played back in your browser.'}
      href={project.runner === 'cloud' ? '/settings#machine' : '/connect'}
      action={project.runner === 'cloud' ? 'Set up Relay Cloud' : 'Connect your computer'}
    />
  );
}

function Line({ className, dot, text, href, action }: { className?: string; dot: string; text: string; href: string; action: string }) {
  return (
    <div className={cn('border-b bg-muted/60 text-xs', className)}>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center">
        <span className="font-medium text-foreground">{dot}</span>
        <span className="text-muted-foreground">{text}</span>
        <Link href={href} className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline">
          {action}
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
