'use client';

import { useState } from 'react';
import { Braces, Info, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getNodeType, type FieldSpec } from '@/lib/connectors';
import { VARIABLE_HINTS } from '@/lib/workflow/template';
import { useStudio } from '@/lib/store';
import type { ValidationIssue } from '@/lib/workflow/validate';
import type { CanvasNode } from './types';
import { PORT_LEGEND } from './node';
import { AgentStatusStrip } from '@/components/agents/agent-status-strip';

interface Props {
  node: CanvasNode | null;
  issues: ValidationIssue[];
  onChange: (nodeId: string, patch: { label?: string | null; config?: Record<string, unknown> }) => void;
  onDelete: (nodeId: string) => void;
}

export function Inspector({ node, issues, onChange, onDelete }: Props) {
  const connections = useStudio((state) => state.connections);
  if (node === null) {
    return (
      <div className="flex h-full flex-col gap-3 p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground">
          <Info className="size-4" />
          <p className="font-medium">Nothing selected</p>
        </div>
        <p>Click a node to edit its settings. Drag from the left to add one.</p>
        <div className="mt-2 rounded-lg border bg-muted/40 p-3">
          <p className="mb-2 text-xs font-medium text-foreground">Port colours</p>
          <ul className="grid grid-cols-2 gap-1 text-xs">
            {PORT_LEGEND.map((port) => (
              <li key={port.type} className="flex items-center gap-1.5">
                <span className={`size-2.5 rounded-full ${port.type === 'issue' ? 'bg-sky-500' : port.type === 'run' ? 'bg-violet-500' : port.type === 'change' ? 'bg-blue-600' : port.type === 'event' ? 'bg-zinc-400' : 'bg-zinc-300'}`} />
                {port.label}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px]">A connection is allowed when the colours match or either end accepts anything.</p>
        </div>
        <div className="rounded-lg border bg-muted/40 p-3 text-xs">
          <p className="mb-1 font-medium text-foreground">Shortcuts</p>
          <p>Backspace deletes · ⌘K searches · drag from a port to connect</p>
        </div>
      </div>
    );
  }

  const def = getNodeType(node.data.typeId);
  if (def === undefined) {
    return (
      <div className="p-4 text-sm">
        <p className="font-medium text-destructive">Unknown node type</p>
        <p className="mt-1 text-xs text-muted-foreground">{node.data.typeId}</p>
        <Button variant="destructive" size="sm" className="mt-3" onClick={() => onDelete(node.id)}>
          <Trash2 data-icon="inline-start" /> Delete
        </Button>
      </div>
    );
  }

  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const connected = connections[def.connectorId] !== undefined || def.connector.category === 'core';

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <ConnectorIcon connector={def.connector} size={20} />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {def.connector.name} · {def.kind}
            </p>
            <p className="text-sm font-semibold leading-tight">{def.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{def.description}</p>
          </div>
        </div>

        {!connected ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">
            {def.connector.name} is not connected. The workflow still saves and simulates; connect it on the Integrations page before exporting.
          </div>
        ) : null}

        {nodeIssues.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {nodeIssues.map((issue, index) => (
              <li key={index} className={`rounded-lg border p-2.5 text-xs ${issue.level === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'}`}>
                <p className="font-medium">{issue.message}</p>
                {issue.hint !== undefined ? <p className="mt-0.5 opacity-80">{issue.hint}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="node-label" className="text-xs">
            Label
          </Label>
          <Input id="node-label" value={node.data.label ?? ''} placeholder={def.name} onChange={(event) => onChange(node.id, { label: event.target.value.length === 0 ? null : event.target.value })} className="h-8 text-sm" />
        </div>

        {def.connectorId === 'pipeline' && def.specId !== 'estimate' ? (
          <AgentStatusStrip used={['planner', 'planReviewer', 'implementer', 'codeReviewer'].map((role) => String(node.data.config[role] ?? '')).filter(Boolean)} />
        ) : null}

        {def.fields.length > 0 ? (
          <div className="grid gap-3">
            {def.fields.map((field) => (
              <FieldControl key={field.key} field={field} value={node.data.config[field.key]} onChange={(value) => onChange(node.id, { config: { ...node.data.config, [field.key]: value } })} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">This node has no settings.</p>
        )}

        {def.sample !== undefined ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Sample payload</summary>
            <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">{JSON.stringify(def.sample, null, 2)}</pre>
          </details>
        ) : null}

        <div className="flex flex-wrap gap-1">
          {def.inputs.map((port) => (
            <Badge key={`in-${port.id}`} variant="outline" className="text-[10px]">
              in: {port.label} ({port.type})
            </Badge>
          ))}
          {def.outputs.map((port) => (
            <Badge key={`out-${port.id}`} variant="outline" className="text-[10px]">
              out: {port.label} ({port.type})
            </Badge>
          ))}
        </div>

        <Button variant="destructive" size="sm" className="self-start" onClick={() => onDelete(node.id)}>
          <Trash2 data-icon="inline-start" /> Delete node
        </Button>
      </div>
    </ScrollArea>
  );
}

function FieldControl({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (value: unknown) => void }) {
  const id = `field-${field.key}`;
  const label = (
    <Label htmlFor={id} className="flex items-center gap-1 text-xs">
      {field.label}
      {field.required === true ? <span className="text-destructive">*</span> : null}
    </Label>
  );
  const help = field.help !== undefined ? <p className="text-[11px] text-muted-foreground">{field.help}</p> : null;

  switch (field.type) {
    case 'boolean':
      return (
        <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
          <div className="grid gap-0.5">
            {label}
            {help}
          </div>
          <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        </div>
      );
    case 'select':
      return (
        <div className="grid gap-1.5">
          {label}
          <Select value={typeof value === 'string' ? value : field.default === undefined ? null : String(field.default)} onValueChange={(next) => onChange(next)} items={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}>
            <SelectTrigger id={id} className="w-full" size="sm">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    {option.description !== undefined ? <span className="text-[11px] text-muted-foreground">{option.description}</span> : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {help}
        </div>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="grid gap-1.5">
          {label}
          <div className="grid gap-1 rounded-lg border p-2">
            {(field.options ?? []).map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-xs">
                <Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />
                {option.label}
              </label>
            ))}
          </div>
          {help}
        </div>
      );
    }
    case 'number':
      return (
        <div className="grid gap-1.5">
          {label}
          <Input id={id} type="number" value={value === undefined || value === null ? '' : String(value)} min={field.min} max={field.max} step={field.step} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} className="h-8 text-sm" />
          {help}
        </div>
      );
    case 'textarea':
    case 'json':
      return (
        <div className="grid gap-1.5">
          {label}
          <Textarea id={id} value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className={`min-h-20 text-sm ${field.type === 'json' ? 'font-mono text-xs' : ''}`} />
          {help}
        </div>
      );
    case 'template':
      return <TemplateField id={id} label={label} help={help} field={field} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
    case 'secret':
      return (
        <div className="grid gap-1.5">
          {label}
          <Input id={id} type="password" value={typeof value === 'string' ? value : ''} placeholder={field.placeholder ?? '••••••••'} onChange={(event) => onChange(event.target.value)} className="h-8 text-sm" />
          <p className="text-[11px] text-muted-foreground">Stored in this browser only. The export refers to it by secret name.</p>
        </div>
      );
    default:
      return (
        <div className="grid gap-1.5">
          {label}
          <Input id={id} value={typeof value === 'string' ? value : value === undefined ? '' : String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className="h-8 text-sm" />
          {help}
        </div>
      );
  }
}

function TemplateField({ id, label, help, field, value, onChange }: { id: string; label: React.ReactNode; help: React.ReactNode; field: FieldSpec; value: string; onChange: (value: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        {label}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
            <Braces data-icon="inline-start" /> Variables
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-2">
            <ScrollArea className="h-64">
              {VARIABLE_HINTS.map((group) => (
                <div key={group.group} className="mb-2">
                  <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.group}</p>
                  {group.variables.map((variable) => (
                    <button
                      key={variable.path}
                      type="button"
                      className="flex w-full flex-col items-start rounded-md px-1.5 py-1 text-left hover:bg-muted"
                      onClick={() => {
                        onChange(`${value}${value.length > 0 && !value.endsWith(' ') ? ' ' : ''}{{${variable.path}}}`);
                        setOpen(false);
                      }}
                    >
                      <span className="font-mono text-xs">{`{{${variable.path}}}`}</span>
                      <span className="text-[11px] text-muted-foreground">{variable.description}</span>
                    </button>
                  ))}
                </div>
              ))}
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>
      <Textarea id={id} value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className="min-h-20 font-mono text-xs" />
      {help}
    </div>
  );
}
