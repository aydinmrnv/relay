/**
 * Values typed into a node's secret fields stay in the browser they were
 * typed in. The export never contains them (it names the repository secret
 * instead), so the account has no use for them either: every copy that
 * leaves for the server — sync, versions, share links, imports — has them
 * blanked, and loading the account puts this browser's values back.
 */
import { getNodeType } from '@/lib/connectors';
import type { Workflow } from '@/lib/workflow/schema';

const cache = new Map<string, string[]>();

function secretKeys(typeId: string): string[] {
  let keys = cache.get(typeId);
  if (keys === undefined) {
    keys = (getNodeType(typeId)?.fields ?? []).filter((field) => field.type === 'secret').map((field) => field.key);
    cache.set(typeId, keys);
  }
  return keys;
}

/** The workflow with every secret field emptied; the same object when it has none filled in. */
export function withoutSecrets(workflow: Workflow): Workflow {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const keys = secretKeys(node.data.typeId).filter((key) => typeof node.data.config[key] === 'string' && node.data.config[key] !== '');
    if (keys.length === 0) return node;
    changed = true;
    return { ...node, data: { ...node.data, config: { ...node.data.config, ...Object.fromEntries(keys.map((key) => [key, ''])) } } };
  });
  return changed ? { ...workflow, nodes } : workflow;
}

/** The server's copy, with the secret values this browser still has put back in. */
export function withLocalSecrets(server: Workflow, local: Workflow | undefined): Workflow {
  if (local === undefined) return server;
  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = server.nodes.map((node) => {
    const mine = localNodes.get(node.id);
    if (mine === undefined || mine.data.typeId !== node.data.typeId) return node;
    const restored = secretKeys(node.data.typeId).filter((key) => typeof mine.data.config[key] === 'string' && mine.data.config[key] !== '' && (node.data.config[key] ?? '') === '');
    if (restored.length === 0) return node;
    changed = true;
    return { ...node, data: { ...node.data, config: { ...node.data.config, ...Object.fromEntries(restored.map((key) => [key, mine.data.config[key]])) } } };
  });
  return changed ? { ...server, nodes } : server;
}
