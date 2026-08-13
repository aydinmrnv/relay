import { git } from '../../git/repository.ts';
import { describeFailure, runProcess } from '../../process/runner.ts';
import { RelayError } from '../../util/errors.ts';
import {
  changedPaths,
  fastForward,
  inspectCheckout,
  newCommits,
  usesCompiledBuild,
} from '../../update/checkout.ts';
import { describeInstallation, installedVersion, type Installation } from '../../update/installation.ts';
import { bullet, dim, heading, ok, out, rows, section } from '../output.ts';

/** A dependency install or a build, not a network fetch, but neither is quick. */
const NPM_TIMEOUT_MS = 600_000;

export interface NpmResult {
  ok: boolean;
  /** Why it failed, ready to print. Empty when it did not. */
  detail: string;
}

/**
 * Everything the update touches outside itself. Injected so the flow can be
 * tested against a real checkout without installing a package or running a
 * build — the two steps that would otherwise make this command untestable.
 */
export interface UpdateDeps {
  installation: () => Promise<Installation>;
  npm: (args: readonly string[], cwd: string) => Promise<NpmResult>;
}

/** How many of the incoming commits to name before summarizing the rest. */
const COMMITS_SHOWN = 5;

/**
 * Updates Relay itself.
 *
 * The subject here is the installed package, never the repository Relay was
 * invoked against: `relay --update` is run from inside somebody's project, and
 * that project is not the thing being updated. So the first question is where
 * this copy came from, because that is what decides how it is replaced — a
 * checkout is fast-forwarded, an npm-managed copy is reinstalled, and an
 * arrangement Relay does not recognize is reported rather than guessed at.
 */
export async function updateCommand(): Promise<number> {
  return runUpdate({
    installation: () => describeInstallation(),
    npm: async (args, cwd) => {
      const result = await runProcess('npm', [...args], { cwd, timeoutMs: NPM_TIMEOUT_MS });
      return { ok: result.ok, detail: result.ok ? '' : describeFailure(result) };
    },
  });
}

export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const installation = await deps.installation();

  heading('relay --update');
  rows([
    { label: 'Installed', value: `${kindLabel(installation.kind)} · ${installation.root}` },
    { label: 'Version', value: installation.version },
  ]);
  out();

  if (installation.kind === 'git') return updateCheckout(installation, deps);
  if (installation.kind === 'npm') return reinstall(installation, deps);

  throw new RelayError(`Relay at ${installation.root} was not installed in a way it can update itself.`, {
    code: 'UPDATE_UNSUPPORTED',
    hint:
      'It is neither a git checkout nor an npm-managed package, so update it the way you installed it.\n' +
      (installation.spec === null ? '' : `Reinstalling would be: npm install -g ${installation.spec}`),
  });
}

/**
 * The checkout path: fetch, fast-forward, and then do the two things a new
 * revision can invalidate — installed dependencies and compiled output. Both
 * are conditional, because doing them unconditionally is a minute of waiting
 * for a change that touched neither.
 */
async function updateCheckout(installation: Installation, deps: UpdateDeps): Promise<number> {
  const root = installation.root;
  const state = await inspectCheckout(root);

  rows([
    { label: 'Branch', value: `${state.branch} → ${state.upstream}` },
    { label: 'Commit', value: state.head },
  ]);

  if (state.behind === 0) {
    out();
    ok(
      state.ahead === 0
        ? 'Already the latest version.'
        : `Already the latest version — ${plural(state.ahead, 'local commit')} not on ${state.upstream}.`,
    );
    return 0;
  }

  if (state.ahead > 0) {
    throw new RelayError(
      `The Relay checkout has diverged from ${state.upstream}: ` +
        `${plural(state.ahead, 'local commit')} and ${plural(state.behind, 'new commit')} upstream.`,
      {
        code: 'UPDATE_DIVERGED',
        hint:
          `Relay only fast-forwards, so it will not merge that for you. In ${root}, ` +
          'rebase or reset the branch yourself, then run `relay --update` again.',
      },
    );
  }

  const subjects = await newCommits(root, 'HEAD', state.upstream, COMMITS_SHOWN);
  section(`Updating ${plural(state.behind, 'commit')} behind ${state.upstream}`);
  for (const subject of subjects) bullet(subject);
  if (state.behind > subjects.length) out(dim(`    and ${state.behind - subjects.length} more`));
  out();

  await fastForward(root, state.upstream);
  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: root });
  ok(`Fast-forwarded ${state.head} → ${head}.`);

  // Only a revision that touched the manifest can have changed what is
  // installed, and only a checkout that runs compiled output needs building:
  // `bin/relay.mjs` prefers `dist/` when it exists and runs the sources
  // directly when it does not.
  const changed = await changedPaths(root, state.head, head);
  if (changed.includes('package.json') || changed.includes('package-lock.json')) {
    await npmStep('Installed dependencies', ['install', '--no-audit', '--no-fund'], root, deps);
  }
  if (await usesCompiledBuild(root)) {
    await npmStep('Rebuilt dist', ['run', 'build'], root, deps);
  }

  reportVersion(installation, await installedVersion(root));
  return 0;
}

/**
 * The npm path: hand the whole job to npm, which owns this copy. Relay is
 * distributed from its repository, so the spec is normally a git one — the
 * same command the user would run themselves, run for them.
 */
async function reinstall(installation: Installation, deps: UpdateDeps): Promise<number> {
  if (installation.spec === null) {
    throw new RelayError('Relay cannot tell which package to reinstall.', {
      code: 'UPDATE_NO_SPEC',
      hint: `Its package.json at ${installation.root} names neither a repository nor a package name.`,
    });
  }

  const args = ['install', '-g', installation.spec];
  out(dim(`  npm ${args.join(' ')}`));
  out();

  const result = await deps.npm(args, installation.root);
  if (!result.ok) {
    throw new RelayError(`npm could not reinstall Relay.\n${result.detail}`, {
      code: 'UPDATE_NPM_FAILED',
      hint:
        'A global install often needs different permissions than a run does. ' +
        `Run it yourself if so:\n  npm ${args.join(' ')}`,
    });
  }

  ok('Reinstalled.');
  reportVersion(installation, await installedVersion(installation.root));
  return 0;
}

async function npmStep(label: string, args: readonly string[], root: string, deps: UpdateDeps): Promise<void> {
  const result = await deps.npm(args, root);
  if (!result.ok) {
    throw new RelayError(`${label.toLowerCase()} failed.\n${result.detail}`, {
      code: 'UPDATE_STEP_FAILED',
      hint:
        `The new code is in place — only this step failed, so Relay may not run until it succeeds.\n` +
        `Run \`npm ${args.join(' ')}\` in ${root}.`,
    });
  }
  ok(`${label}.`);
}

/**
 * The closing line. A version that did not move is still reported, because a
 * checkout can gain a dozen commits without bumping one, and silence there
 * reads as a failed update.
 */
function reportVersion(installation: Installation, version: string | null): void {
  out();
  if (version === null || version === installation.version) {
    out(`Relay is up to date at ${installation.version}.`);
    return;
  }
  out(`Relay is up to date: ${installation.version} → ${version}.`);
}

function kindLabel(kind: Installation['kind']): string {
  if (kind === 'git') return 'git checkout';
  return kind === 'npm' ? 'npm package' : 'unrecognized install';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
