'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import type { Connector } from '@/lib/connectors';
import { authExplainer, authLabel } from './connector-meta';

interface Props {
  connector: Connector | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The one step a connection has in the prototype: name the account. The copy
 * says what the hosted product would do instead, so nobody mistakes the mock
 * for a real sign-in.
 */
export function ConnectDialog({ connector, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed so the account label starts empty for every app. */}
        {connector === null ? null : <ConnectForm key={connector.id} connector={connector} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({ connector, onDone }: { connector: Connector; onDone: () => void }) {
  const brand = useBrand();
  const connect = useStudio((state) => state.connect);
  const [account, setAccount] = useState('');
  const fallback = connector.auth === 'local' ? 'this machine' : `acme (${connector.name})`;
  const how = authExplainer(connector, brand.name);

  const submit = () => {
    const label = account.trim() || fallback;
    connect(connector.id, label);
    toast.success(`${connector.name} marked as connected`, { description: `Account “${label}”. This is a local flag in this browser; no sign-in happened.` });
    onDone();
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <div className="flex items-center gap-3">
          <ConnectorIcon connector={connector} size={20} />
          <div className="min-w-0">
            <DialogTitle>Connect {connector.name}</DialogTitle>
            <DialogDescription className="mt-1">
              {authLabel(connector)} · {connector.triggers.length} triggers · {connector.actions.length} actions
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="grid gap-1 text-[13px]">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">In the hosted product</p>
        <p className="font-medium">{how.title}</p>
        <p className="leading-relaxed text-muted-foreground">{how.body}</p>
      </div>

      <div className="flex gap-2.5 rounded-lg border border-dashed border-warning/40 bg-warning/5 p-3 text-[13px] leading-relaxed text-muted-foreground">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          <span className="font-medium text-foreground">This prototype only pretends.</span> Connecting records the label below in this browser and nothing else: no sign-in, no key, no request to {connector.name}.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="connect-account">Account label</Label>
        <Input id="connect-account" autoFocus value={account} onChange={(event) => setAccount(event.target.value)} placeholder={fallback} />
        <p className="text-xs text-muted-foreground">Shown on the card and in the builder, so you can tell workspaces apart. Leave it empty to use “{fallback}”.</p>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Connect (mock)</Button>
      </DialogFooter>
    </form>
  );
}
