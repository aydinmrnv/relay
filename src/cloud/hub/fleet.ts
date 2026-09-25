import { createHash } from 'node:crypto';

import type { CloudRunnerState, CloudRunnerStatus } from '../../studio/protocol.ts';
import { errorMessage } from '../../util/errors.ts';
import type { RunnerActivity } from '../frames.ts';
import { CloudError, type CloudDriver, type CloudMachine } from './driver.ts';

/**
 * One machine per person, awake only while it is needed.
 *
 * The fleet decides, for every person with a runner, what their machine
 * should be doing, and asks the cloud to make it so. It is a reconciler, not a
 * script: it never assumes a request it made has landed. Every `tick` it
 * compares what it wants with what the cloud last said and with which runners
 * are connected, and does the next step — so a hub that crashed halfway
 * through starting a machine simply carries on after the restart.
 *
 * What it wants:
 *
 *   - **Awake when asked.** A person pressing Run, or signing in, wakes their
 *     machine. Reads never do: the studio polling for status must not start
 *     a machine nobody is using.
 *   - **Asleep when idle.** No run, no sign-in in progress, no request for
 *     `idleMs`: deallocate. A deallocated machine costs its disk and nothing
 *     else, and keeps every sign-in.
 *   - **Room for whoever is waiting.** CPUs are a per-region quota. When a
 *     region is full, a machine that has been idle for `pressureIdleMs` gives
 *     up its place early; otherwise the wake waits its turn, in order.
 *   - **Nothing stuck.** A machine that is running but never dials in is
 *     restarted once, then put to sleep with an error the person can see. A
 *     machine left `stopped` (still billed) is deallocated.
 *
 * A runner that dials in without a cloud machine behind it — someone's own
 * server, or a development VM with a token minted by hand — is "unmanaged":
 * routed to like any other, never started or stopped.
 */

export type RunnerState = CloudRunnerState;
export type RunnerStatus = CloudRunnerStatus;

export interface FleetLink {
  /** Closes the connection, e.g. when another one for the same person replaces it. */
  close(code: number, reason: string): void;
}

export interface FleetOptions {
  /** Null when the hub manages no machines: only runners that dial in on their own. */
  driver: CloudDriver | null;
  regions: readonly string[];
  coresPerRunner: number;
  /** Machine names are `<prefix>-<hash of the user id>`. */
  namePrefix?: string;
  tokenFor: (runner: string, userId: string) => string;
  /** Null to admit, or the reason a person may not have a machine. */
  admit?: (userId: string) => string | null;
  maxMachines?: number;
  idleMs?: number;
  pressureIdleMs?: number;
  /** How long a started machine has to dial in; a first boot installs everything and gets longer. */
  bootTimeoutMs?: number;
  firstBootTimeoutMs?: number;
  /** How long a failed or refused create or start waits before it is tried again. */
  retryMs?: number;
  now?: () => number;
  log?: (event: FleetEvent) => void;
}

export interface FleetEvent {
  kind: 'create' | 'start' | 'restart' | 'deallocate' | 'remove' | 'connected' | 'disconnected' | 'queued' | 'error' | 'reconciled';
  userId?: string;
  runner?: string;
  region?: string;
  message: string;
}

interface Machine {
  userId: string;
  name: string;
  region: string | null;
  managed: boolean;
  state: RunnerState;
  since: number;
  cloud: CloudMachine | null;
  link: FleetLink | null;
  connectedOnce: boolean;
  activity: RunnerActivity;
  /** Requests the hub is carrying to this runner right now, and the streams it is following. */
  inflight: number;
  lastUsedAt: number;
  /** Someone asked for it to be awake and it is not yet. */
  wanted: boolean;
  wantedAt: number;
  /** When it last started booting, for the boot timeout. */
  bootedAt: number;
  firstBoot: boolean;
  bootAttempts: number;
  error: string | null;
  /** A cloud call is in flight; nothing else is asked until it returns. */
  busy: boolean;
  /** Not before this time: a create or start the cloud refused. */
  retryAt: number;
}

const IDLE_ACTIVITY: RunnerActivity = { runs: 0, queued: 0, logins: 0 };
/** How long the fleet trusts its own last step over a listing that contradicts it. */
const SETTLE_MS = 90_000;
/** Extra time a runner that dropped mid-run gets to come back before its machine is restarted under it. */
const RUNNING_GRACE_MS = 10 * 60_000;

type Waiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> };

export function runnerName(prefix: string, userId: string): string {
  // 12 base-32 characters of a hash: a valid Azure name (lower case, starts with
  // a letter via the prefix), stable for a person, and says nothing about them.
  const digest = createHash('sha256').update(userId).digest();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return `${prefix}-${out}`;
}

export class Fleet {
  private readonly machines = new Map<string, Machine>();
  private readonly byName = new Map<string, string>();
  private readonly options: Required<Omit<FleetOptions, 'driver' | 'admit' | 'log' | 'now'>> & Pick<FleetOptions, 'driver' | 'admit' | 'log' | 'now'>;
  /** Waiting to wake, per region, oldest first. */
  private readonly queues = new Map<string, string[]>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private capacityCache = new Map<string, { at: number; freeCores: number; ourCoresAtRead: number }>();
  /** Regions the cloud said were full, until when. */
  private readonly fullUntil = new Map<string, number>();
  private listedOnce = false;
  private lastListed = -1;
  private ticking = false;

  constructor(options: FleetOptions) {
    this.options = {
      namePrefix: 'relay',
      maxMachines: 50,
      idleMs: 10 * 60_000,
      pressureIdleMs: 2 * 60_000,
      bootTimeoutMs: 6 * 60_000,
      firstBootTimeoutMs: 25 * 60_000,
      retryMs: 60_000,
      ...options,
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(event: FleetEvent): void {
    this.options.log?.(event);
  }

  get managesMachines(): boolean {
    return this.options.driver !== null;
  }

  /* -------------------------------------------------------------- */
  /* What the hub asks                                               */
  /* -------------------------------------------------------------- */

  status(userId: string): RunnerStatus {
    const machine = this.machines.get(userId);
    if (machine === undefined) {
      return { state: 'none', managed: this.managesMachines, region: null, since: new Date(this.now()).toISOString(), position: null, error: null, activity: null };
    }
    let position: number | null = null;
    if (machine.state === 'queued' && machine.region !== null) {
      const index = (this.queues.get(machine.region) ?? []).indexOf(userId);
      position = index >= 0 ? index + 1 : null;
    }
    return {
      state: machine.state,
      managed: machine.managed,
      region: machine.region,
      since: new Date(machine.since).toISOString(),
      position,
      error: machine.error,
      activity: machine.link === null ? null : { ...machine.activity },
    };
  }

  /** The user a managed machine belongs to, by its name. */
  ownerOf(runner: string): string | undefined {
    return this.byName.get(runner);
  }

  isReady(userId: string): boolean {
    return this.machines.get(userId)?.state === 'ready';
  }

  /**
   * Counts a request the hub is carrying; the machine is not put to sleep
   * while any is open. Only a request that does something (`touch`) restarts
   * the idle clock: a studio tab left open polls for status every thirty
   * seconds, and that must not keep a machine awake forever.
   */
  use(userId: string, options: { touch?: boolean } = {}): () => void {
    const machine = this.machines.get(userId);
    if (machine === undefined) return () => undefined;
    const touch = options.touch !== false;
    machine.inflight += 1;
    if (touch) machine.lastUsedAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      machine.inflight = Math.max(0, machine.inflight - 1);
      if (touch) machine.lastUsedAt = this.now();
    };
  }

  /** Asks for the person's machine to be awake: made if they have none, started if asleep, queued if the region is full. */
  async wake(userId: string): Promise<RunnerStatus> {
    let machine = this.machines.get(userId);
    if (machine !== undefined && !machine.managed) {
      if (machine.state !== 'ready') machine.error = 'Your runner is offline. Start `relay connect --hub` where it runs.';
      return this.status(userId);
    }
    if (this.options.driver === null) {
      return { ...this.status(userId), error: 'This hub does not start machines. Connect a runner of your own with `relay connect --hub`.' };
    }
    if (!this.listedOnce) await this.reconcile().catch(() => undefined);
    machine = this.machines.get(userId);

    if (machine === undefined) {
      const refusal = this.options.admit?.(userId) ?? null;
      if (refusal !== null) return { ...this.status(userId), error: refusal };
      const managed = [...this.machines.values()].filter((entry) => entry.managed).length;
      if (managed >= this.options.maxMachines) {
        return { ...this.status(userId), error: 'Relay Cloud is full right now. Try again later, or run on your own machine with `relay connect`.' };
      }
      machine = this.track(userId, runnerName(this.options.namePrefix, userId), null, true);
      machine.state = 'none';
    }

    machine.lastUsedAt = this.now();
    if (machine.state === 'ready' || machine.state === 'creating' || machine.state === 'starting' || machine.state === 'deleting') return this.status(userId);
    if (!machine.wanted) {
      machine.wanted = true;
      machine.wantedAt = this.now();
      machine.error = null;
    }
    if (machine.state === 'failed') machine.retryAt = 0;
    await this.admitQueued();
    return this.status(userId);
  }

  /** Resolves true once the person's runner is connected, false when the time runs out. */
  whenReady(userId: string, timeoutMs: number): Promise<boolean> {
    if (this.isReady(userId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const set = this.waiters.get(userId) ?? new Set<Waiter>();
      this.waiters.set(userId, set);
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          set.delete(waiter);
          resolve(true);
        },
        timer: setTimeout(() => {
          set.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      set.add(waiter);
    });
  }

  /** Puts the machine to sleep now, if nothing is running on it. */
  async sleep(userId: string, options: { force?: boolean } = {}): Promise<RunnerStatus> {
    const machine = this.machines.get(userId);
    if (machine === undefined || !machine.managed) return this.status(userId);
    if (options.force !== true && !this.idle(machine)) {
      return { ...this.status(userId), error: 'A run or a sign-in is still going on your machine.' };
    }
    machine.wanted = false;
    this.dequeue(machine);
    if (machine.state === 'ready' || machine.state === 'starting' || machine.state === 'creating') await this.deallocate(machine, 'asked to sleep');
    return this.status(userId);
  }

  /** Removes the person's machine and its disk: every sign-in on it goes too. */
  async remove(userId: string): Promise<RunnerStatus> {
    const machine = this.machines.get(userId);
    if (machine === undefined || !machine.managed || this.options.driver === null) return this.status(userId);
    machine.wanted = false;
    this.dequeue(machine);
    if (machine.cloud === null && machine.state === 'none') {
      this.forget(machine);
      return this.status(userId);
    }
    this.transition(machine, 'deleting');
    machine.busy = true;
    try {
      await this.options.driver.remove({ name: machine.name, region: machine.region ?? '' });
      this.log({ kind: 'remove', userId, runner: machine.name, message: `Removing ${machine.name}.` });
    } catch (error) {
      if (!(error instanceof CloudError && error.kind === 'not-found')) {
        machine.error = `Could not remove your machine: ${errorMessage(error)}`;
        this.log({ kind: 'error', userId, runner: machine.name, message: machine.error });
      }
    } finally {
      machine.busy = false;
    }
    machine.link?.close(4410, 'machine removed');
    return this.status(userId);
  }

  /* -------------------------------------------------------------- */
  /* Runners dialing in                                              */
  /* -------------------------------------------------------------- */

  /**
   * A runner dialed in. False when the fleet is putting that machine to sleep:
   * its runner reconnects in the seconds before the power goes, and must not
   * be mistaken for a machine that is awake.
   */
  connected(identity: { runner: string; userId: string }, link: FleetLink, activity: RunnerActivity): boolean {
    let machine = this.machines.get(identity.userId);
    if (machine !== undefined && machine.managed && machine.name === identity.runner && machine.state === 'stopping') return false;
    if (machine === undefined) {
      const managedName = this.options.driver === null ? null : runnerName(this.options.namePrefix, identity.userId);
      machine = this.track(identity.userId, identity.runner, null, identity.runner === managedName);
    }
    if (machine.link !== null && machine.link !== link) machine.link.close(4409, 'replaced by a newer connection');
    if (machine.name !== identity.runner && machine.managed) {
      // A hand-started runner for someone whose managed machine is asleep: route to it.
      machine.managed = false;
    }
    machine.link = link;
    machine.connectedOnce = true;
    machine.firstBoot = false;
    machine.activity = { ...activity };
    machine.lastUsedAt = this.now();
    machine.bootAttempts = 0;
    machine.error = null;
    machine.wanted = false;
    this.dequeue(machine);
    this.transition(machine, 'ready');
    this.log({ kind: 'connected', userId: identity.userId, runner: identity.runner, message: `${identity.runner} connected.` });
    for (const waiter of [...(this.waiters.get(identity.userId) ?? [])]) waiter.resolve();
    return true;
  }

  disconnected(userId: string, link: FleetLink): void {
    const machine = this.machines.get(userId);
    if (machine === undefined || machine.link !== link) return;
    machine.link = null;
    this.log({ kind: 'disconnected', userId, runner: machine.name, message: `${machine.name} disconnected.` });
    if (!machine.managed) {
      this.transition(machine, 'offline');
      return;
    }
    if (machine.state === 'ready') {
      // The runner process restarted or the network blinked: give it the
      // ordinary boot time to come back before calling it stuck, and longer
      // when a run was going, which a restart of the machine would end.
      machine.bootedAt = this.now() + (machine.activity.runs + machine.activity.queued > 0 ? RUNNING_GRACE_MS : 0);
      machine.firstBoot = false;
      this.transition(machine, 'starting');
    }
  }

  reportActivity(userId: string, activity: RunnerActivity): void {
    const machine = this.machines.get(userId);
    if (machine === undefined) return;
    const busy = (value: RunnerActivity) => value.runs + value.queued + value.logins > 0;
    // The idle clock starts when the last piece of work ends, not when it began.
    if (busy(activity) || busy(machine.activity)) machine.lastUsedAt = this.now();
    machine.activity = { ...activity };
  }

  /* -------------------------------------------------------------- */
  /* Reconciling with the cloud                                      */
  /* -------------------------------------------------------------- */

  /** Reads every runner machine from the cloud and folds it into what the fleet knows. */
  async reconcile(): Promise<void> {
    const driver = this.options.driver;
    if (driver === null) return;
    const listed = await driver.list();
    const seen = new Set<string>();
    for (const cloud of listed) {
      seen.add(cloud.userId);
      let machine = this.machines.get(cloud.userId);
      if (machine === undefined) {
        machine = this.track(cloud.userId, cloud.name, cloud.region, true);
        // A machine the hub has not seen connect since it started: if it is
        // running, it gets a boot's grace to dial in before it counts as stuck.
        machine.bootedAt = this.now();
        machine.firstBoot = cloud.createdAt !== null && this.now() - cloud.createdAt < this.options.firstBootTimeoutMs;
      }
      if (!machine.managed && machine.link !== null) continue;
      machine.managed = true;
      machine.cloud = cloud;
      machine.region = cloud.region;
      if (machine.name !== cloud.name) {
        this.byName.delete(machine.name);
        machine.name = cloud.name;
        this.byName.set(cloud.name, cloud.userId);
      }
      this.adopt(machine, cloud);
    }
    for (const machine of this.machines.values()) {
      if (!machine.managed || seen.has(machine.userId) || machine.busy) continue;
      if (machine.state === 'creating' && this.now() - machine.since < 60_000) continue; // not listed yet
      if (machine.state === 'deleting' || machine.cloud !== null) {
        machine.cloud = null;
        if (machine.link === null) {
          if (machine.wanted) this.transition(machine, 'none');
          else this.forget(machine);
        }
      }
    }
    this.listedOnce = true;
    // Said when it changes, not every thirty seconds.
    if (listed.length !== this.lastListed) this.log({ kind: 'reconciled', message: `${listed.length} machine${listed.length === 1 ? '' : 's'} in the cloud.` });
    this.lastListed = listed.length;
  }

  /** What the cloud says, turned into a state, without undoing a step the fleet has in flight. */
  private adopt(machine: Machine, cloud: CloudMachine): void {
    if (machine.busy) return;
    const powered = cloud.power === 'running' || cloud.power === 'starting' || cloud.power === 'unknown';
    if (machine.link !== null && powered) {
      if (machine.state !== 'ready') this.transition(machine, 'ready');
      return;
    }
    // A listing read just before the fleet's own start or stop landed still
    // shows the old power state; give the cloud a moment before believing it.
    const settling = this.now() - machine.since < SETTLE_MS;
    if (settling && (machine.state === 'starting' || machine.state === 'creating') && (cloud.power === 'deallocated' || cloud.power === 'stopped')) return;
    if (settling && machine.state === 'stopping' && (cloud.power === 'running' || cloud.power === 'starting')) return;
    if (cloud.provisioning === 'deleting') return this.transition(machine, 'deleting');
    if (cloud.provisioning === 'failed') {
      if (machine.state !== 'failed') {
        machine.error = machine.error ?? 'Your machine could not be made. Try again, and if it keeps failing, tell us.';
        this.transition(machine, 'failed');
      }
      return;
    }
    if (cloud.provisioning === 'creating') {
      if (machine.state !== 'creating') {
        machine.firstBoot = true;
        machine.bootedAt = machine.bootedAt || this.now();
        this.transition(machine, 'creating');
      }
      return;
    }
    switch (cloud.power) {
      case 'running':
      case 'starting':
        if (machine.state !== 'creating' && machine.state !== 'starting') {
          machine.bootedAt = this.now();
          this.transition(machine, machine.firstBoot ? 'creating' : 'starting');
        }
        return;
      case 'stopping':
      case 'deallocating':
        if (machine.state !== 'stopping') this.transition(machine, 'stopping');
        return;
      case 'stopped':
        // Shut down from inside: still holding its CPUs, and still billed.
        if (machine.state !== 'stopping') this.transition(machine, 'stopping');
        return;
      case 'deallocated':
        if (machine.state === 'queued') return;
        if (machine.state === 'failed' && !machine.wanted) return;
        if (machine.state !== 'asleep') this.transition(machine, machine.wanted ? 'queued' : 'asleep');
        if (machine.wanted) this.enqueue(machine);
        return;
      default:
        return;
    }
  }

  /**
   * One step towards what the fleet wants. Safe to call as often as you like:
   * a second tick while one is running returns at once.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const machine of [...this.machines.values()]) {
        if (!machine.managed || machine.busy) continue;
        const cloud = machine.cloud;

        // Stopped but still allocated: finish the job, or it keeps billing.
        if (cloud?.power === 'stopped' && machine.link === null) {
          await this.deallocate(machine, 'it was stopped but still allocated');
          continue;
        }

        if (machine.state === 'ready' && this.idle(machine) && now - machine.lastUsedAt >= this.options.idleMs) {
          await this.deallocate(machine, `idle for ${Math.round((now - machine.lastUsedAt) / 60_000)} minutes`);
          continue;
        }

        if ((machine.state === 'starting' || machine.state === 'creating') && machine.link === null && cloud?.provisioning !== 'creating') {
          const limit = machine.firstBoot ? this.options.firstBootTimeoutMs : this.options.bootTimeoutMs;
          if (now - machine.bootedAt >= limit) await this.recover(machine);
          continue;
        }

        if (machine.state === 'creating' && cloud?.provisioning === 'creating' && now - machine.since >= this.options.firstBootTimeoutMs) {
          machine.error = 'Making your machine is taking far longer than it should. It has been stopped; try again in a few minutes.';
          await this.deallocate(machine, 'stuck while being made');
          continue;
        }
      }
      await this.admitQueued();
    } finally {
      this.ticking = false;
    }
  }

  /** A machine that is running but never dialed in: restart it once, then give up with an error. */
  private async recover(machine: Machine): Promise<void> {
    const driver = this.options.driver;
    if (driver === null || machine.region === null) return;
    if (machine.bootAttempts < 1) {
      machine.bootAttempts += 1;
      machine.busy = true;
      try {
        await driver.restart({ name: machine.name, region: machine.region });
        machine.bootedAt = this.now();
        machine.firstBoot = false;
        this.log({ kind: 'restart', userId: machine.userId, runner: machine.name, message: `${machine.name} never connected; restarting it.` });
      } catch (error) {
        this.log({ kind: 'error', userId: machine.userId, runner: machine.name, message: `Restarting ${machine.name} failed: ${errorMessage(error)}` });
      } finally {
        machine.busy = false;
      }
      return;
    }
    machine.error = 'Your machine started but Relay could not reach it. It has been stopped; press Start to try again.';
    machine.wanted = false;
    await this.deallocate(machine, 'it never connected');
    this.transition(machine, 'failed');
  }

  private idle(machine: Machine): boolean {
    const activity = machine.link === null ? IDLE_ACTIVITY : machine.activity;
    return machine.inflight === 0 && activity.runs === 0 && activity.queued === 0 && activity.logins === 0;
  }

  private async deallocate(machine: Machine, why: string): Promise<void> {
    const driver = this.options.driver;
    if (driver === null || machine.region === null || machine.busy) return;
    machine.busy = true;
    this.transition(machine, 'stopping');
    try {
      await driver.deallocate({ name: machine.name, region: machine.region });
      if (machine.cloud !== null) machine.cloud = { ...machine.cloud, power: 'deallocating' };
      this.log({ kind: 'deallocate', userId: machine.userId, runner: machine.name, region: machine.region, message: `Deallocating ${machine.name}: ${why}.` });
      machine.link?.close(4000, 'going to sleep');
    } catch (error) {
      this.log({ kind: 'error', userId: machine.userId, runner: machine.name, message: `Deallocating ${machine.name} failed: ${errorMessage(error)}` });
    } finally {
      machine.busy = false;
    }
  }

  /* -------------------------------------------------------------- */
  /* Waking, in turn                                                 */
  /* -------------------------------------------------------------- */

  private enqueue(machine: Machine): void {
    if (machine.region === null) return;
    const queue = this.queues.get(machine.region) ?? [];
    if (!queue.includes(machine.userId)) {
      queue.push(machine.userId);
      this.queues.set(machine.region, queue);
    }
  }

  private dequeue(machine: Machine): void {
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(machine.userId);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  /** Cores our own awake machines hold in a region, as far as the fleet knows. */
  private ourCores(region: string): number {
    let count = 0;
    for (const machine of this.machines.values()) {
      if (!machine.managed || machine.region !== region) continue;
      if (machine.state === 'ready' || machine.state === 'starting' || machine.state === 'creating' || machine.state === 'stopping') count += 1;
    }
    return count * this.options.coresPerRunner;
  }

  /** Runner slots free in a region: what the cloud reported, less what the fleet has started since. */
  private async freeSlots(region: string): Promise<number> {
    const driver = this.options.driver;
    if (driver === null) return 0;
    if ((this.fullUntil.get(region) ?? 0) > this.now()) return 0;
    let cached = this.capacityCache.get(region);
    if (cached === undefined || this.now() - cached.at > 30_000) {
      try {
        const capacity = await driver.capacity(region);
        cached = { at: this.now(), freeCores: capacity.limitCores - capacity.usedCores, ourCoresAtRead: this.ourCores(region) };
        this.capacityCache.set(region, cached);
      } catch (error) {
        this.log({ kind: 'error', region, message: `Could not read the quota in ${region}: ${errorMessage(error)}` });
        if (cached === undefined) return 0;
      }
    }
    const startedSince = this.ourCores(region) - cached.ourCoresAtRead;
    return Math.floor((cached.freeCores - startedSince) / this.options.coresPerRunner);
  }

  /** Where a new person's machine goes: the configured region with the most room, then the fewest machines. */
  private async chooseRegion(): Promise<string | null> {
    let best: { region: string; free: number; count: number } | null = null;
    for (const region of this.options.regions) {
      const free = await this.freeSlots(region);
      const count = [...this.machines.values()].filter((machine) => machine.managed && machine.region === region).length;
      if (best === null || free > best.free || (free === best.free && count < best.count)) best = { region, free, count };
    }
    return best?.region ?? null;
  }

  /** Starts or makes machines for whoever is waiting, oldest first, as far as each region has room. */
  private async admitQueued(): Promise<void> {
    const driver = this.options.driver;
    if (driver === null) return;
    // Anyone who wants to be awake and is not on their way yet joins a queue.
    for (const machine of this.machines.values()) {
      if (!machine.wanted || !machine.managed || machine.busy) continue;
      if (machine.state === 'none' && machine.region === null) {
        machine.region = await this.chooseRegion();
        if (machine.region === null) continue;
      }
      if (machine.state === 'none' || machine.state === 'asleep' || machine.state === 'failed') {
        this.transition(machine, 'queued');
        this.enqueue(machine);
        this.log({ kind: 'queued', userId: machine.userId, runner: machine.name, region: machine.region ?? undefined, message: `${machine.name} is waiting to wake in ${machine.region}.` } as FleetEvent);
      }
    }

    for (const [region, queue] of this.queues) {
      while (queue.length > 0) {
        const userId = queue[0]!;
        const machine = this.machines.get(userId);
        if (machine === undefined || machine.state !== 'queued' || !machine.wanted) {
          queue.shift();
          continue;
        }
        if (machine.busy || machine.retryAt > this.now()) break;
        // Still deallocating from an earlier sleep: the cloud will not start it yet.
        if (machine.cloud !== null && (machine.cloud.power === 'deallocating' || machine.cloud.power === 'stopping')) break;
        let free = await this.freeSlots(region);
        if (free <= 0 && (await this.preempt(region))) free = await this.freeSlots(region);
        if (free <= 0) break;
        queue.shift();
        await this.bringUp(machine);
      }
    }
  }

  /** Frees a slot in a full region by putting its longest-idle machine to sleep early. */
  private async preempt(region: string): Promise<boolean> {
    const candidates = [...this.machines.values()]
      .filter((machine) => machine.managed && machine.region === region && machine.state === 'ready' && !machine.busy && this.idle(machine))
      .filter((machine) => this.now() - machine.lastUsedAt >= this.options.pressureIdleMs)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = candidates[0];
    if (victim === undefined) return false;
    await this.deallocate(victim, 'someone else needed the room');
    // It still holds its CPUs until Azure finishes; the slot opens on a later tick.
    return false;
  }

  private async bringUp(machine: Machine): Promise<void> {
    const driver = this.options.driver;
    if (driver === null || machine.region === null) return;
    const exists = machine.cloud !== null;
    machine.busy = true;
    try {
      if (exists && machine.cloud?.provisioning === 'failed') {
        // A machine Azure failed to make cannot be started; remove it, and
        // the next reconcile finds it gone and makes it again.
        await driver.remove({ name: machine.name, region: machine.region });
        this.transition(machine, 'deleting');
        this.log({ kind: 'remove', userId: machine.userId, runner: machine.name, message: `Removing ${machine.name}, which Azure failed to make, to make it again.` });
        return;
      }
      if (!exists) {
        await driver.create({ name: machine.name, userId: machine.userId, region: machine.region, token: this.options.tokenFor(machine.name, machine.userId) });
        machine.firstBoot = true;
        this.transition(machine, 'creating');
        this.log({ kind: 'create', userId: machine.userId, runner: machine.name, region: machine.region, message: `Making ${machine.name} in ${machine.region}.` });
      } else {
        await driver.start({ name: machine.name, region: machine.region });
        this.transition(machine, machine.firstBoot ? 'creating' : 'starting');
        this.log({ kind: 'start', userId: machine.userId, runner: machine.name, region: machine.region, message: `Starting ${machine.name}.` });
      }
      machine.bootedAt = this.now();
      machine.error = null;
    } catch (error) {
      const kind = error instanceof CloudError ? error.kind : 'transient';
      if (kind === 'quota' || kind === 'capacity') {
        // Someone else took the room, or Azure has none of this size here right now.
        this.fullUntil.set(machine.region, this.now() + (kind === 'quota' ? 30_000 : this.options.retryMs));
        this.capacityCache.delete(machine.region);
        this.transition(machine, 'queued');
        this.enqueue(machine);
        machine.error = kind === 'capacity' ? 'Azure has no machines of this size free in your region right now; Relay keeps trying.' : null;
      } else {
        machine.retryAt = this.now() + this.options.retryMs;
        machine.error = `Could not ${exists ? 'start' : 'make'} your machine: ${errorMessage(error)}`;
        if (kind === 'fatal') {
          machine.wanted = false;
          this.transition(machine, 'failed');
        } else {
          this.transition(machine, 'queued');
          this.enqueue(machine);
        }
      }
      this.log({ kind: 'error', userId: machine.userId, runner: machine.name, region: machine.region, message: `${exists ? 'Starting' : 'Making'} ${machine.name}: ${errorMessage(error)}` });
    } finally {
      machine.busy = false;
    }
  }

  /* -------------------------------------------------------------- */

  private track(userId: string, name: string, region: string | null, managed: boolean): Machine {
    const machine: Machine = {
      userId,
      name,
      region,
      managed,
      state: 'none',
      since: this.now(),
      cloud: null,
      link: null,
      connectedOnce: false,
      activity: { ...IDLE_ACTIVITY },
      inflight: 0,
      lastUsedAt: this.now(),
      wanted: false,
      wantedAt: 0,
      bootedAt: 0,
      firstBoot: false,
      bootAttempts: 0,
      error: null,
      busy: false,
      retryAt: 0,
    };
    this.machines.set(userId, machine);
    this.byName.set(name, userId);
    return machine;
  }

  private forget(machine: Machine): void {
    this.dequeue(machine);
    this.machines.delete(machine.userId);
    this.byName.delete(machine.name);
  }

  private transition(machine: Machine, state: RunnerState): void {
    if (machine.state === state) return;
    machine.state = state;
    machine.since = this.now();
  }

  /** A summary for the operator: counts by state and region. */
  summary(): { machines: number; connected: number; byState: Record<string, number>; queued: Record<string, number> } {
    const byState: Record<string, number> = {};
    let connected = 0;
    for (const machine of this.machines.values()) {
      byState[machine.state] = (byState[machine.state] ?? 0) + 1;
      if (machine.link !== null) connected += 1;
    }
    const queued: Record<string, number> = {};
    for (const [region, queue] of this.queues) if (queue.length > 0) queued[region] = queue.length;
    return { machines: this.machines.size, connected, byState, queued };
  }
}
