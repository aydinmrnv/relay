/**
 * What the hub needs from a cloud to keep one machine per person: list them,
 * make one, start, stop and remove one, and say how much room a region has.
 * `azure.ts` is the real one; the tests use an in-memory one.
 *
 * The cloud is the source of truth. Every runner machine carries its owner in
 * its tags, so the hub can lose its memory — a restart, a crash, a move to
 * another host — and rebuild everything it knows from one `list()`.
 */

/** A cloud's view of a runner machine. */
export interface CloudMachine {
  name: string;
  userId: string;
  region: string;
  /**
   * `stopped` still holds its CPUs and is still billed on Azure, unlike
   * `deallocated`; the hub treats it as something to finish stopping.
   */
  power: 'starting' | 'running' | 'stopping' | 'stopped' | 'deallocating' | 'deallocated' | 'unknown';
  provisioning: 'creating' | 'updating' | 'succeeded' | 'failed' | 'deleting' | 'unknown';
  /** When the machine was made, if the cloud says. */
  createdAt: number | null;
}

export interface MachineSpec {
  name: string;
  userId: string;
  region: string;
  /** The runner token the machine presents to the hub. */
  token: string;
}

export interface RegionCapacity {
  /** CPUs in use in the region, by anything in the subscription. */
  usedCores: number;
  limitCores: number;
}

/** A refusal the hub can act on: no room in the region right now, or a request the cloud will never accept. */
export class CloudError extends Error {
  readonly kind: 'quota' | 'capacity' | 'conflict' | 'not-found' | 'fatal' | 'transient';
  constructor(kind: CloudError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CloudDriver {
  /** Every runner machine, with its power state. */
  list(): Promise<CloudMachine[]>;
  /** Starts making a machine; returns once the cloud has accepted the request. */
  create(spec: MachineSpec): Promise<void>;
  start(machine: Pick<CloudMachine, 'name' | 'region'>): Promise<void>;
  restart(machine: Pick<CloudMachine, 'name' | 'region'>): Promise<void>;
  /** Stops and releases the CPUs; the disk, and every sign-in on it, stays. */
  deallocate(machine: Pick<CloudMachine, 'name' | 'region'>): Promise<void>;
  /** Removes the machine and its disk. */
  remove(machine: Pick<CloudMachine, 'name' | 'region'>): Promise<void>;
  capacity(region: string): Promise<RegionCapacity>;
}
