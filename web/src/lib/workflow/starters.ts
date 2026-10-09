/**
 * The automations setup offers first, and how each is fitted to the answers.
 *
 * A starter is one of the templates with the questions setup asks already
 * answered in it: the label that starts it, who may add that label, what a
 * run and a day may cost, which agents do the work. So the workflow somebody
 * leaves setup with exports cleanly, with real logins on its allowlist, where
 * a template arrives with example names the export refuses.
 *
 * What a starter says about how it starts is read off the compiler and the
 * readiness table, never written here: the exported GitHub Action starts by
 * itself only on a GitHub issue event, and a card that claimed more would be
 * claiming it for a runner that does not do it.
 */
import type { Brand } from '../brand';
import { defaultConfig, getNodeType } from '../connectors';
import { compileWorkflow } from './compile';
import { readiness } from './readiness';
import type { ProjectRunner, Workflow } from './schema';
import { instantiateTemplate } from './templates';

export type AgentChoice = 'both' | 'claude' | 'codex';
export type ReviewLevel = 'light' | 'standard' | 'thorough';

export interface StarterOptions {
  repository: string;
  /** The issue label that starts a run, for a workflow that starts on one. */
  label: string;
  /** GitHub logins that may start a run. */
  authors: string[];
  maxRunCostUsd: number;
  maxDailyCostUsd: number;
  agents: AgentChoice;
  review: ReviewLevel;
}

export type StarterId = 'issue-to-pr' | 'quick-fix' | 'ci-fix' | 'dependency-upgrades';

export interface Starter {
  id: StarterId;
  title: string;
  /** What it does in a few words, for a list somebody is choosing from. */
  short: string;
  /** What happens, start to finish, in a sentence. */
  body: string;
  /** Who it suits. */
  when: string;
  /** The template it is cut from. */
  templateId: string;
  defaults: Pick<StarterOptions, 'maxRunCostUsd' | 'maxDailyCostUsd' | 'review'> & { label: (brand: Brand) => string };
}

export const STARTERS: Starter[] = [
  {
    id: 'issue-to-pr',
    title: 'Issue to pull request',
    short: 'Label an issue. Two agents plan, write and review it, then open a draft pull request.',
    body: 'Label an issue. Two agents plan it, write it, review each other’s work and run your tests, then open a draft pull request and report back on the issue.',
    when: 'The one to start with: features and bugs you would hand to a teammate.',
    templateId: 'label-run',
    defaults: { label: (brand) => `${brand.slug}:go`, maxRunCostUsd: 8, maxDailyCostUsd: 40, review: 'standard' },
  },
  {
    id: 'quick-fix',
    title: 'Quick fix from an issue',
    short: 'Label an issue. One agent fixes it in a single session. For small changes.',
    body: 'Label an issue. One agent plans and writes the change in a single session, your tests check it, and a draft pull request opens.',
    when: 'Typos, small bugs and chores, where a full review costs more than the fix.',
    templateId: 'label-run',
    defaults: { label: (brand) => `${brand.slug}:quick`, maxRunCostUsd: 3, maxDailyCostUsd: 15, review: 'light' },
  },
  {
    id: 'ci-fix',
    title: 'Fix main when CI goes red',
    short: 'A failed build on main becomes the task, and a fix comes back as a draft pull request.',
    body: 'When a workflow fails on main, the failing job and its log become the task. One fix at a time, under a budget, as a draft pull request.',
    when: 'A main branch that should never stay broken overnight.',
    templateId: 'ci-fix',
    defaults: { label: (brand) => brand.slug, maxRunCostUsd: 5, maxDailyCostUsd: 20, review: 'light' },
  },
  {
    id: 'dependency-upgrades',
    title: 'Weekly dependency upgrades',
    short: 'Every Monday: upgrade what can be upgraded, fix what breaks, open one pull request.',
    body: 'Every Monday the agents upgrade what can be upgraded, fix what the upgrades break, and open one draft pull request.',
    when: 'Upkeep nobody gets round to.',
    templateId: 'dependency-upgrades',
    defaults: { label: (brand) => brand.slug, maxRunCostUsd: 8, maxDailyCostUsd: 40, review: 'standard' },
  },
];

export function getStarter(id: string): Starter | undefined {
  return STARTERS.find((starter) => starter.id === id);
}

const ROLES: Record<AgentChoice, { planner: string; planReviewer: string; implementer: string; codeReviewer: string }> = {
  both: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
  claude: { planner: 'claude', planReviewer: 'claude', implementer: 'claude', codeReviewer: 'claude' },
  codex: { planner: 'codex', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'codex' },
};

/** What a workflow has that setup can ask about, so it asks nothing a workflow does not use. */
export interface WorkflowAsks {
  /** Starts on a label on a GitHub issue. */
  label: boolean;
  allowlist: boolean;
  budget: boolean;
  /** Has the reviewed pipeline, whose depth is a choice. The fast run has none. */
  review: boolean;
  agents: boolean;
}

export function asksOf(workflow: Workflow): WorkflowAsks {
  const types = new Set(workflow.nodes.map((node) => node.data.typeId));
  return {
    label: types.has('github-issues.trigger.issue-labelled'),
    allowlist: types.has('gates.action.allowlist'),
    budget: types.has('gates.action.budget'),
    review: types.has('pipeline.action.run'),
    agents: types.has('pipeline.action.run') || types.has('pipeline.action.fast'),
  };
}

/** Writes the answers into whichever nodes take them. A workflow without a budget gate gains none: this fits, it does not redraw. */
export function fitWorkflow(workflow: Workflow, options: StarterOptions): Workflow {
  const roles = ROLES[options.agents];
  const authors = options.authors.map((login) => login.trim().replace(/^@/, '')).filter((login) => login.length > 0);
  return {
    ...workflow,
    repository: options.repository,
    nodes: workflow.nodes.map((node) => {
      const set = (config: Record<string, unknown>) => ({ ...node, data: { ...node.data, config: { ...node.data.config, ...config } } });
      switch (node.data.typeId) {
        case 'github-issues.trigger.issue-labelled':
          return options.label.trim().length > 0 ? set({ label: options.label.trim() }) : node;
        case 'gates.action.allowlist':
          // The template's example names and team go: a list of real logins, or an empty one that refuses everybody.
          return set({ authors: authors.join('\n'), teams: '' });
        case 'gates.action.budget':
          return set({ maxRunCostUsd: options.maxRunCostUsd, maxDailyCostUsd: options.maxDailyCostUsd });
        case 'pipeline.action.run':
          return set({ ...roles, review: options.review });
        case 'pipeline.action.fast':
          return set({ implementer: roles.implementer });
        default:
          return node;
      }
    }),
  };
}

/** Swaps the reviewed pipeline for the single-session one. Both take a ticket and hand on a run, so every connection stays. */
function withFastPipeline(workflow: Workflow): Workflow {
  const fast = getNodeType('pipeline.action.fast');
  if (fast === undefined) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => (node.data.typeId === 'pipeline.action.run' ? { ...node, data: { ...node.data, typeId: fast.id, config: defaultConfig(fast) } } : node)),
  };
}

/** The starter as a workflow of somebody's own, with their answers in it. `undefined` only if its template is gone. */
export function buildStarter(id: StarterId, brand: Brand, options: StarterOptions): Workflow | undefined {
  const starter = getStarter(id);
  if (starter === undefined) return undefined;
  const base = instantiateTemplate(starter.templateId, brand, options.repository);
  if (base === undefined) return undefined;
  const shaped = id === 'quick-fix' ? withFastPipeline(base) : base;
  // A starter cut from a template under another name is not that template any more.
  const named = starter.templateId === 'label-run' ? { ...shaped, name: starter.title, description: starter.body, templateId: undefined } : shaped;
  return fitWorkflow(named, options);
}

export interface StartsHow {
  /** Whether an event starts it on this runner with nobody pressing anything. */
  itself: boolean;
  headline: string;
  detail: string;
}

/**
 * How a workflow starts on the runner a project chose. On GitHub Actions that
 * is what the compiler would write into the workflow file; on a machine it is
 * what `relay workflow serve` can keep.
 */
export function startsOn(workflow: Workflow, runner: ProjectRunner, brand: Brand): StartsHow {
  if (runner !== 'actions') {
    const ready = readiness(workflow);
    return { itself: ready.unattended, headline: ready.unattended ? 'Starts by itself' : ready.headline, detail: ready.detail };
  }
  const start = compileWorkflow(workflow, brand).start;
  if (start.by === 'label') {
    return { itself: true, headline: 'Starts by itself on GitHub Actions', detail: `Add the label ${start.label} to an issue and the run starts in your repository.` };
  }
  if (start.by === 'event') {
    return { itself: true, headline: 'Starts by itself on GitHub Actions', detail: `Starts when ${start.event}, on an issue that also carries the label ${start.label}.` };
  }
  return {
    itself: false,
    headline: 'Started by hand on GitHub Actions',
    detail: 'GitHub Actions runs it on one issue at a time, so you start it with an issue number from the Actions tab. To have its own trigger start it, run it on your computer.',
  };
}
