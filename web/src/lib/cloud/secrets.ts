/**
 * Values typed into a node's secret fields — typed as secrets in the
 * catalog, or named like credentials — stay in the browser they were typed in. The export never contains them (it names the repository secret
 * instead), so the account has no use for them either: every copy that
 * leaves for the server — sync, versions, share links, imports — has them
 * blanked, and loading the account puts this browser's values back.
 */
import { isSecretField } from '@/lib/workflow/redact';
import type { Workflow } from '@/lib/workflow/schema';

/** Keys in this node's settings that hold a credential and are filled in. */
function filledSecrets(typeId: string, config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => isSecretField(typeId, key) && typeof config[key] === 'string' && config[key] !== '');
}

/** The workflow with every secret field emptied; the same object when it has none filled in. */
export function withoutSecrets(workflow: Workflow): Workflow {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const keys = filledSecrets(node.data.typeId, node.data.config);
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
    const restored = filledSecrets(mine.data.typeId, mine.data.config).filter((key) => (node.data.config[key] ?? '') === '');
    if (restored.length === 0) return node;
    changed = true;
    return { ...node, data: { ...node.data, config: { ...node.data.config, ...Object.fromEntries(restored.map((key) => [key, mine.data.config[key]])) } } };
  });
  return changed ? { ...server, nodes } : server;
}
