'use client';

import { useRef, useState } from 'react';
import { Download, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { SwitchMode } from '@/components/watermelon/switch-mode';
import { BrandMark } from '@/components/app/brand-mark';
import { AgentAccountsCard } from '@/components/agents/agent-accounts-card';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import type { AuthPreference, ExecutionTier, Settings } from '@/lib/workflow/schema';

const TIERS: Array<{ value: ExecutionTier; title: string; description: string; badge: string }> = [
  { value: 'actions', title: 'Your GitHub Actions', description: 'Exported workflows run on your own minutes. Free on public repos, 3,000 min/month on private with GitHub Pro.', badge: 'Free' },
  { value: 'hosted', title: 'Hosted microVMs', description: 'One Firecracker VM per run, every connector bridged. Not built yet; the export still works.', badge: 'Later' },
  { value: 'self-hosted', title: 'Self-hosted runner', description: 'relay serve in your VPC, pointed at the control plane. Not built yet.', badge: 'Later' },
];

export default function SettingsPage() {
  // The form seeds its inputs from the store, so it must not mount before the
  // store has read localStorage.
  const hydrated = useStudio((state) => state.hydrated);
  if (!hydrated) return null;
  return <SettingsForm />;
}

function SettingsForm() {
  const brand = useBrand();
  const setBrand = useStudio((state) => state.setBrand);
  const settings = useStudio((state) => state.settings);
  const updateSettings = useStudio((state) => state.updateSettings);
  const exportAll = useStudio((state) => state.exportAll);
  const importAll = useStudio((state) => state.importAll);
  const resetAll = useStudio((state) => state.resetAll);
  const [name, setName] = useState(brand.name);
  const [tagline, setTagline] = useState(brand.tagline);
  const [repository, setRepository] = useState(settings.defaultRepository);
  const fileInput = useRef<HTMLInputElement>(null);

  const saveBrand = () => {
    setBrand(name, tagline);
    toast.success(`This is now called ${name.trim() || brand.name}.`);
  };

  const download = () => {
    const blob = new Blob([exportAll()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${brand.slug}-studio-export.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onImport = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      const result = importAll(JSON.parse(await file.text()));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch {
      toast.error('That file is not valid JSON.');
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Everything here lives in this browser. Nothing is sent anywhere.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Product name</CardTitle>
            <CardDescription>The name is not decided. Change it here and every screen, slug and export follows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
              <BrandMark className="size-10 text-lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold">{name.trim() || brand.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  slug <span className="font-mono">{(name.trim() || brand.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}</span> · trigger label{' '}
                  <span className="font-mono">{(name.trim() || brand.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}:go</span>
                </p>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Relay" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tagline">Tagline</Label>
              <Input id="tagline" value={tagline} onChange={(event) => setTagline(event.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">
              Build-time default comes from <span className="font-mono">NEXT_PUBLIC_PRODUCT_NAME</span>. This field overrides it locally.
            </p>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setName('Relay');
                setBrand('Relay');
              }}
            >
              Reset to Relay
            </Button>
            <Button onClick={saveBrand}>Save name</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where runs execute</CardTitle>
            <CardDescription>Only the first tier exists. The others are here so the export and the product story line up.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={settings.executionTier} onValueChange={(value) => updateSettings({ executionTier: value as ExecutionTier })} className="gap-3">
              {TIERS.map((tier) => (
                <Label key={tier.value} htmlFor={`tier-${tier.value}`} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary">
                  <RadioGroupItem id={`tier-${tier.value}`} value={tier.value} className="mt-0.5" />
                  <div className="grid gap-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {tier.title}
                      <Badge variant={tier.badge === 'Free' ? 'default' : 'secondary'}>{tier.badge}</Badge>
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">{tier.description}</span>
                  </div>
                </Label>
              ))}
            </RadioGroup>
            <div className="mt-4 grid gap-2">
              <Label htmlFor="repo">Default repository</Label>
              <Input id="repo" value={repository} onChange={(event) => setRepository(event.target.value)} onBlur={() => updateSettings({ defaultRepository: repository.trim() || 'acme/api' })} placeholder="owner/repo" />
            </div>
            <div className="mt-4 grid gap-2">
              <Label>Credentials in exported workflows</Label>
              {(
                [
                  ['claude', 'Claude Code', 'CLAUDE_CODE_OAUTH_TOKEN from claude setup-token', 'ANTHROPIC_API_KEY'],
                  ['codex', 'Codex', 'CODEX_AUTH_JSON from ~/.codex/auth.json', 'OPENAI_API_KEY'],
                ] as const
              ).map(([id, label, subHint, keyHint]) => (
                <div key={id} className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{settings.auth[id] === 'subscription' ? subHint : keyHint}</p>
                  </div>
                  <RadioGroup value={settings.auth[id]} onValueChange={(value) => updateSettings({ auth: { ...settings.auth, [id]: value as AuthPreference } })} className="flex gap-3">
                    <Label htmlFor={`auth-${id}-sub`} className="flex items-center gap-1.5 text-xs">
                      <RadioGroupItem id={`auth-${id}-sub`} value="subscription" /> Subscription
                    </Label>
                    <Label htmlFor={`auth-${id}-key`} className="flex items-center gap-1.5 text-xs">
                      <RadioGroupItem id={`auth-${id}-key`} value="api-key" /> API key
                    </Label>
                  </RadioGroup>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <AgentAccountsCard />

        <Card>
          <CardHeader>
            <CardTitle>Simulation & appearance</CardTitle>
            <CardDescription>How fast test runs play back, and which theme the studio uses.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <RadioGroup value={settings.simulationSpeed} onValueChange={(value) => updateSettings({ simulationSpeed: value as Settings['simulationSpeed'] })} className="grid grid-cols-3 gap-2">
              {(
                [
                  ['instant', 'Instant', 'no waiting'],
                  ['fast', 'Fast', '~15 seconds'],
                  ['realistic', 'Realistic', '~a minute'],
                ] as const
              ).map(([value, label, hint]) => (
                <Label key={value} htmlFor={`speed-${value}`} className="flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 has-data-checked:border-primary">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <RadioGroupItem id={`speed-${value}`} value={value} /> {label}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">{hint}</span>
                </Label>
              ))}
            </RadioGroup>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Theme</p>
                <p className="text-xs text-muted-foreground">Follows your system by default.</p>
              </div>
              <div className="scale-75">
                <SwitchMode />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Your data</CardTitle>
            <CardDescription>Workflows, runs, connections and the brand, as one JSON file.</CardDescription>
          </CardHeader>
          <CardFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={download}>
              <Download data-icon="inline-start" /> Export everything
            </Button>
            <Button variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload data-icon="inline-start" /> Import
            </Button>
            <input ref={fileInput} type="file" accept="application/json" className="hidden" onChange={(event) => void onImport(event.target.files?.[0])} />
            <Button
              variant="destructive"
              className="ml-auto"
              onClick={() => {
                resetAll();
                toast('Reset. The starter workflows will be recreated.');
              }}
            >
              <RotateCcw data-icon="inline-start" /> Reset demo data
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
