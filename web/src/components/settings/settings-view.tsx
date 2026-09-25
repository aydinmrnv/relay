'use client';

import { useEffect, useState } from 'react';
import { Bot, Database, Laptop, Palette, Rocket, Tag, UserRound } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { AgentAccountsCard } from '@/components/agents/agent-accounts-card';
import { AccountSettings } from '@/components/account/account-settings';
import { useAccount } from '@/lib/cloud/account';
import { MachineCard } from '@/components/companion/machine-card';
import { CloudCard, RunnerPicker } from '@/components/companion/cloud-card';
import { useCompanion } from '@/lib/companion/client';
import { SectionChips, SectionNav, type SectionLink } from '@/components/guide/section-nav';
import { FadeIn } from '@/components/motion/fade-in';
import { Skeleton } from '@/components/ui/skeleton';
import { useStudio } from '@/lib/store';
import { SettingsSection } from './settings-section';
import { GeneralSettings } from './general-settings';
import { RunningSettings } from './running-settings';
import { AppearanceSettings } from './appearance-settings';
import { DataSettings } from './data-settings';

const SECTIONS: SectionLink[] = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'general', label: 'General', icon: Tag },
  { id: 'machine', label: 'Where agents run', icon: Laptop },
  { id: 'agents', label: 'Coding agents', icon: Bot },
  { id: 'running', label: 'Running & exporting', icon: Rocket },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'data', label: 'Your data', icon: Database },
];
const SECTION_IDS = SECTIONS.map((section) => section.id);

export function SettingsView() {
  // The forms seed their drafts from the store, so they must not mount before
  // the store has read localStorage.
  const hydrated = useStudio((state) => state.hydrated);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const target = useCompanion((state) => state.target);
  const hasCloud = useCompanion((state) => state.cloudHub !== null);
  // Bumped after an import or a reset, so drafts re-seed from the new data.
  const [generation, setGeneration] = useState(0);

  // On a full page load of /settings#agents the browser looks for the anchor
  // before the sections exist (they wait for the store), so jump once they do.
  useEffect(() => {
    if (!hydrated) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id.length > 0) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hydrated]);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6 md:pb-24">
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6">
        <PageHeader
          title="Settings"
          description={
            signedIn
              ? 'Your account, and how the studio behaves. Changes apply as you make them and are saved to your account, so every browser you sign in to gets them.'
              : 'Everything here is stored in this browser’s local storage until you create an account. Changes apply as you make them unless a Save button says otherwise.'
          }
        />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <SectionNav items={SECTIONS} ids={SECTION_IDS} title="Settings" />
          </aside>

          <div className="grid min-w-0 grid-cols-1 gap-12">
            <SectionChips items={SECTIONS} ids={SECTION_IDS} title="Settings sections" className="-mb-8 lg:hidden" />

            {!hydrated ? (
              <div className="grid gap-4" aria-busy="true" aria-label="Loading settings">
                <Skeleton className="h-8 w-60" />
                <Skeleton className="h-72 w-full rounded-xl" />
                <Skeleton className="h-48 w-full rounded-xl" />
              </div>
            ) : (
              <FadeIn className="grid grid-cols-1 gap-12" key={generation}>
                <SettingsSection id="account" icon={UserRound} title="Account" description={signedIn ? 'Your profile, how you sign in, and where.' : 'Keep your work in any browser, share it, and keep its history.'}>
                  <AccountSettings />
                </SettingsSection>

                <SettingsSection
                  id="general"
                  icon={Tag}
                  title="General"
                  description="What the product is called. The name is still undecided, so it is a setting: change it and everything follows."
                >
                  <GeneralSettings />
                </SettingsSection>

                <SettingsSection
                  id="machine"
                  icon={Laptop}
                  term="companion"
                  title="Where agents run"
                  description={
                    hasCloud
                      ? 'Where sign-ins and real runs happen: your own computer, paired by relay connect, or a machine of your own on Relay Cloud. Either way the agents use your plans and your sign-ins.'
                      : 'The Relay CLI on your computer, paired with this studio by relay connect. It is how sign-ins, real runs and installing an export reach your machine; the pairing is kept in this browser only, apart from your other data.'
                  }
                >
                  <div className="grid gap-4">
                    {hasCloud ? <RunnerPicker /> : null}
                    {target === 'cloud' && hasCloud ? <CloudCard /> : <MachineCard />}
                  </div>
                </SettingsSection>

                <SettingsSection
                  id="agents"
                  icon={Bot}
                  term="subscription"
                  title="Coding agents"
                  description="The pipeline’s work is done by coding CLIs on your own plan: Claude Code with a Claude subscription, Codex with a ChatGPT one. No API keys to paste. Sign in once; the studio asks the CLIs on your machine whether they are signed in and never sees a token."
                >
                  <AgentAccountsCard />
                </SettingsSection>

                <SettingsSection
                  id="running"
                  icon={Rocket}
                  term="export"
                  title="Running & exporting"
                  description="Where exported workflows run, which repository new workflows attach to, and which credentials an export asks for."
                >
                  <RunningSettings />
                </SettingsSection>

                <SettingsSection id="appearance" icon={Palette} title="Appearance" description="How the studio looks and moves, and how fast test runs play back. Applied immediately.">
                  <AppearanceSettings />
                </SettingsSection>

                <SettingsSection
                  id="data"
                  icon={Database}
                  title="Your data"
                  description={signedIn ? 'Everything in your account, as one file. Take it with you, bring a file back in, or clear it out.' : 'Everything the studio knows lives in this browser. Take it with you, bring it back, or start again from the demo.'}
                >
                  <DataSettings onReplaced={() => setGeneration((value) => value + 1)} />
                </SettingsSection>
              </FadeIn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
