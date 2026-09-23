'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useBrand } from '@/hooks/use-brand';
import { brandFromName, DEFAULT_BRAND } from '@/lib/brand';
import { useStudio } from '@/lib/store';
import { SettingBlock } from './settings-section';

/**
 * The product name and tagline. Edits are a draft with a live preview of
 * everything derived from the name; nothing changes until Save, because a
 * rename rewrites every screen at once.
 */
export function GeneralSettings() {
  const brand = useBrand();
  const setBrand = useStudio((state) => state.setBrand);
  const [name, setName] = useState(brand.name);
  const [tagline, setTagline] = useState(brand.tagline);

  // Exactly what saving would produce, so the preview cannot disagree with the result.
  const draft = brandFromName(name, tagline);
  const dirty = draft.name !== brand.name || draft.tagline !== brand.tagline;
  const isDefault = brand.name === DEFAULT_BRAND.name && brand.tagline === DEFAULT_BRAND.tagline;

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setBrand(draft.name, draft.tagline);
    setName(draft.name);
    setTagline(draft.tagline);
    toast.success(draft.name === brand.name ? 'Tagline saved.' : `Renamed to ${draft.name}.`, {
      description: draft.name === brand.name ? undefined : 'Every screen, the page title and new exports use it now.',
    });
  };

  const restore = () => {
    setBrand(DEFAULT_BRAND.name, DEFAULT_BRAND.tagline);
    setName(DEFAULT_BRAND.name);
    setTagline(DEFAULT_BRAND.tagline);
    toast.success(`Back to ${DEFAULT_BRAND.name}.`);
  };

  const derived: Array<{ label: string; value: string; what: string }> = [
    { label: 'Slug', value: draft.slug, what: 'Names export files and the Action’s concurrency group.' },
    { label: 'Trigger label', value: `${draft.slug}:go`, what: 'The GitHub label that starts a label-triggered run.' },
    { label: 'Branch prefix', value: `${draft.slug}/eng-142-fix-login-redirect`, what: 'Where each run commits its work.' },
    { label: 'Export bundle', value: `${draft.slug}-workflow.json`, what: 'The graph file you can import again.' },
  ];

  return (
    <Card className="gap-0 py-0">
      <form onSubmit={save}>
        <div className="grid gap-4 p-4 md:p-5">
          {/* Live preview: how the studio would introduce itself with the draft name. */}
          <div className="relative overflow-hidden rounded-xl border bg-muted/30 p-4">
            <div aria-hidden className="pointer-events-none absolute -top-16 -right-12 size-40 rounded-full bg-primary/15 blur-3xl" />
            <div className="relative flex items-center gap-3">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-indigo-500 text-lg font-semibold text-white shadow-sm" aria-hidden>
                {draft.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold">{draft.name}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{draft.tagline}</p>
              </div>
              {dirty ? <span className="ml-auto shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-warning">Preview, not saved</span> : null}
            </div>
            <dl className="relative mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {derived.map((item) => (
                <div key={item.label} className="min-w-0">
                  <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{item.label}</dt>
                  <dd className="truncate font-mono text-[13px]">{item.value}</dd>
                  <dd className="text-xs text-muted-foreground">{item.what}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="text-sm text-pretty text-muted-foreground">
            The name is not decided yet, so nothing hard-codes it. Screens, page titles, slugs and exports follow what you save here. Workflows you already built keep the label and branch prefix written into
            their nodes; new workflows and templates use the new ones.
          </p>
        </div>
        <Separator />
        <SettingBlock htmlFor="brand-name" title="Product name" description="Shown in the sidebar, page titles, help text and exported files.">
          <Input id="brand-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={DEFAULT_BRAND.name} maxLength={40} autoComplete="off" className="max-w-sm" />
        </SettingBlock>
        <Separator />
        <SettingBlock htmlFor="brand-tagline" title="Tagline" description="One line of positioning, shown with the name on the landing page.">
          <Input id="brand-tagline" value={tagline} onChange={(event) => setTagline(event.target.value)} placeholder={DEFAULT_BRAND.tagline} maxLength={140} />
        </SettingBlock>
        <CardFooter className="flex-wrap justify-between gap-2 border-t bg-muted/30 px-4 py-3 md:px-5">
          <p className="text-xs text-muted-foreground">
            Build-time default: <span className="font-mono">NEXT_PUBLIC_PRODUCT_NAME</span>. This overrides it in this browser only.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={restore} disabled={isDefault && !dirty}>
              <RotateCcw data-icon="inline-start" /> Use {DEFAULT_BRAND.name}
            </Button>
            <Button type="submit" disabled={!dirty}>
              Save name
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
