import { runProcess } from '../../process/runner.ts';
import { CloudError, type CloudDriver, type CloudMachine, type MachineSpec, type RegionCapacity } from './driver.ts';

/**
 * Runner machines on Azure, through the Resource Manager REST API.
 *
 * No SDK and no secret. On the hub's own VM the token comes from its managed
 * identity through the instance metadata service; an operator running the hub
 * elsewhere can use their Azure CLI sign-in instead. The identity needs
 * Contributor on the one resource group the runners live in, and nothing else.
 *
 * Layout, made once by `scripts/azure/deploy-hub.sh`:
 *
 *   resource group   relay-cloud            (holds everything below, in any region)
 *   per region       relay-runners-<region> a virtual network whose subnet keeps
 *                                           default outbound access: the runners'
 *                                           only way out, free, and no way in
 *   per person       <name>                 the VM, tagged relay-role=runner and
 *                    <name>-nic, <name>-os  relay-user=<Clerk id>; its NIC and disk
 *                                           are deleted with it
 */

const COMPUTE_API = '2024-07-01';
const NETWORK_API = '2024-05-01';
const ARM = 'https://management.azure.com';

export type AzureCredential = 'managed-identity' | 'azure-cli';

export interface AzureDriverOptions {
  subscriptionId: string;
  resourceGroup: string;
  credential: AzureCredential;
  vmSize: string;
  /** A marketplace image `publisher:offer:sku:version`, or a gallery image version's resource id. */
  image: string;
  osDiskType: 'Standard_LRS' | 'StandardSSD_LRS' | 'Premium_LRS';
  osDiskGb: number;
  adminUser: string;
  /** Required by Azure for a Linux VM; only reachable through Azure's run-command, since runners have no public address. */
  sshPublicKey: string;
  /** The runner's cloud-init, made per machine (it names the hub). */
  customData: (spec: MachineSpec) => string;
  /** The subnet a region's runners join. Defaults to `relay-runners-<region>/runners` in the resource group. */
  subnetId?: (region: string) => string;
  fetchImpl?: typeof fetch;
}

interface ArmError {
  error?: { code?: string; message?: string };
}

/** Sorts an ARM error into something the fleet can act on. */
export function classifyArmError(status: number, code: string, message: string): CloudError['kind'] {
  const text = `${code} ${message}`;
  if (status === 404 || code === 'ResourceNotFound' || code === 'NotFound') return 'not-found';
  if (/quota|QuotaExceeded|exceeding approved/i.test(text)) return 'quota';
  if (/AllocationFailed|ZonalAllocationFailed|OverconstrainedAllocationRequest|SkuNotAvailable|capacity/i.test(text)) return 'capacity';
  if (status === 409 || code === 'Conflict' || code === 'OperationNotAllowed') return 'conflict';
  if (status === 429 || status >= 500) return 'transient';
  return 'fatal';
}

const POWER: Record<string, CloudMachine['power']> = {
  'PowerState/starting': 'starting',
  'PowerState/running': 'running',
  'PowerState/stopping': 'stopping',
  'PowerState/stopped': 'stopped',
  'PowerState/deallocating': 'deallocating',
  'PowerState/deallocated': 'deallocated',
};

interface ArmVm {
  id?: string;
  name?: string;
  location?: string;
  tags?: Record<string, string> | null;
  properties?: {
    provisioningState?: string;
    timeCreated?: string;
    instanceView?: { statuses?: Array<{ code?: string }> };
  };
}

function powerOf(statuses: Array<{ code?: string }> | undefined): CloudMachine['power'] {
  let power: CloudMachine['power'] = 'unknown';
  for (const status of statuses ?? []) {
    const mapped = status.code === undefined ? undefined : POWER[status.code];
    if (mapped !== undefined) power = mapped;
  }
  return power;
}

/**
 * Reads one VM. `status` is the same VM from the subscription's
 * `statusOnly=true` list, which is where Azure puts power states: listing a
 * resource group with `$expand=instanceView` is refused once it holds a VM
 * ("only supported when Virtual Machine Scale Set resource filter is
 * applied"), and the status list carries no tags. Exported for the tests.
 */
export function machineFromArm(vm: ArmVm, status?: ArmVm): CloudMachine | null {
  const tags = vm.tags ?? {};
  if (tags['relay-role'] !== 'runner' || typeof tags['relay-user'] !== 'string' || vm.name === undefined || vm.location === undefined) return null;
  const power = powerOf(status?.properties?.instanceView?.statuses ?? vm.properties?.instanceView?.statuses);
  const state = (vm.properties?.provisioningState ?? '').toLowerCase();
  const provisioning: CloudMachine['provisioning'] =
    state === 'creating' || state === 'updating' || state === 'succeeded' || state === 'failed' || state === 'deleting' ? state : 'unknown';
  const created = vm.properties?.timeCreated === undefined ? NaN : Date.parse(vm.properties.timeCreated);
  // Azure spells a region `spaincentral` in one answer and `SpainCentral` in another.
  return { name: vm.name, userId: tags['relay-user'], region: vm.location.toLowerCase(), power, provisioning, createdAt: Number.isNaN(created) ? null : created };
}

export class AzureDriver implements CloudDriver {
  private readonly options: AzureDriverOptions;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: AzureDriverOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt - Date.now() > 5 * 60_000) return this.token.value;
    if (this.options.credential === 'managed-identity') {
      const url = `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(`${ARM}/`)}`;
      const response = await this.fetchImpl(url, { headers: { Metadata: 'true' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new CloudError('transient', `The managed identity answered ${response.status}. Does this VM have one?`);
      const body = (await response.json()) as { access_token?: string; expires_on?: string };
      if (typeof body.access_token !== 'string') throw new CloudError('transient', 'The managed identity returned no token.');
      this.token = { value: body.access_token, expiresAt: Number(body.expires_on ?? '0') * 1000 };
      return body.access_token;
    }
    const result = await runProcess('az', ['account', 'get-access-token', '--resource', `${ARM}/`, '--output', 'json'], { timeoutMs: 30_000 });
    if (!result.ok) throw new CloudError('transient', `az account get-access-token failed: ${result.stderr.trim().split('\n').at(-1) ?? ''}`);
    const body = JSON.parse(result.stdout) as { accessToken?: string; expires_on?: number; expiresOn?: string };
    if (typeof body.accessToken !== 'string') throw new CloudError('transient', 'The Azure CLI returned no token.');
    const expiresAt = typeof body.expires_on === 'number' ? body.expires_on * 1000 : Date.parse(body.expiresOn ?? '') || Date.now() + 30 * 60_000;
    this.token = { value: body.accessToken, expiresAt };
    return body.accessToken;
  }

  private async arm<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${ARM}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new CloudError('transient', `Azure did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    const parsed = text.length === 0 ? ({} as T) : (JSON.parse(text) as T);
    if (!response.ok) {
      const error = (parsed as ArmError).error ?? {};
      const code = error.code ?? String(response.status);
      const message = error.message ?? `Azure answered ${response.status}.`;
      throw new CloudError(classifyArmError(response.status, code, message), `${code}: ${message}`);
    }
    return { status: response.status, body: parsed };
  }

  private group(): string {
    return `/subscriptions/${this.options.subscriptionId}/resourceGroups/${this.options.resourceGroup}`;
  }

  private vmPath(name: string): string {
    return `${this.group()}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}`;
  }

  subnetId(region: string): string {
    return this.options.subnetId?.(region) ?? `${this.group()}/providers/Microsoft.Network/virtualNetworks/relay-runners-${region}/subnets/runners`;
  }

  private async all(path: string): Promise<ArmVm[]> {
    const items: ArmVm[] = [];
    let next: string | null = path;
    while (next !== null) {
      const page: { body: { value?: ArmVm[]; nextLink?: string } } = await this.arm('GET', next);
      items.push(...(page.body.value ?? []));
      next = page.body.nextLink === undefined ? null : page.body.nextLink.replace(ARM, '');
    }
    return items;
  }

  async list(): Promise<CloudMachine[]> {
    const [vms, statuses] = await Promise.all([
      this.all(`${this.group()}/providers/Microsoft.Compute/virtualMachines?api-version=${COMPUTE_API}`),
      this.all(`/subscriptions/${this.options.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=${COMPUTE_API}&statusOnly=true`),
    ]);
    const byId = new Map(statuses.filter((vm) => vm.id !== undefined).map((vm) => [vm.id!.toLowerCase(), vm]));
    const machines: CloudMachine[] = [];
    for (const vm of vms) {
      const machine = machineFromArm(vm, vm.id === undefined ? undefined : byId.get(vm.id.toLowerCase()));
      if (machine !== null) machines.push(machine);
    }
    return machines;
  }

  private imageReference(): Record<string, string> {
    const image = this.options.image;
    if (image.startsWith('/')) return { id: image };
    const [publisher, offer, sku, version] = image.split(':');
    if (publisher === undefined || offer === undefined || sku === undefined) throw new CloudError('fatal', `"${image}" is not an image.`);
    return { publisher, offer, sku, version: version ?? 'latest' };
  }

  async create(spec: MachineSpec): Promise<void> {
    const tags = { 'relay-role': 'runner', 'relay-user': spec.userId };
    const nicName = `${spec.name}-nic`;
    const nic = `${this.group()}/providers/Microsoft.Network/networkInterfaces/${encodeURIComponent(nicName)}`;
    await this.arm('PUT', `${nic}?api-version=${NETWORK_API}`, {
      location: spec.region,
      tags,
      properties: {
        ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: this.subnetId(spec.region) }, privateIPAllocationMethod: 'Dynamic' } }],
      },
    });

    const galleryImage = this.options.image.startsWith('/');
    await this.arm('PUT', `${this.vmPath(spec.name)}?api-version=${COMPUTE_API}`, {
      location: spec.region,
      tags,
      properties: {
        hardwareProfile: { vmSize: this.options.vmSize },
        storageProfile: {
          imageReference: this.imageReference(),
          osDisk: {
            name: `${spec.name}-os`,
            createOption: 'FromImage',
            diskSizeGB: this.options.osDiskGb,
            managedDisk: { storageAccountType: this.options.osDiskType },
            deleteOption: 'Delete',
          },
        },
        osProfile: {
          computerName: spec.name,
          adminUsername: this.options.adminUser,
          // A baked image already has everything; cloud-init still writes the hub's address.
          customData: Buffer.from(this.options.customData(spec)).toString('base64'),
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            ssh: { publicKeys: [{ path: `/home/${this.options.adminUser}/.ssh/authorized_keys`, keyData: this.options.sshPublicKey }] },
            provisionVMAgent: true,
          },
        },
        // The runner reads its token from the instance metadata service at
        // every connect, so it is never written to the disk.
        userData: Buffer.from(spec.token).toString('base64'),
        networkProfile: { networkInterfaces: [{ id: nic, properties: { primary: true, deleteOption: 'Delete' } }] },
        diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        securityProfile: galleryImage ? undefined : { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
      },
    });
  }

  async start(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    await this.arm('POST', `${this.vmPath(machine.name)}/start?api-version=${COMPUTE_API}`);
  }

  async restart(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    await this.arm('POST', `${this.vmPath(machine.name)}/restart?api-version=${COMPUTE_API}`);
  }

  async deallocate(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    await this.arm('POST', `${this.vmPath(machine.name)}/deallocate?api-version=${COMPUTE_API}`);
  }

  async remove(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    await this.arm('DELETE', `${this.vmPath(machine.name)}?api-version=${COMPUTE_API}`);
  }

  async capacity(region: string): Promise<RegionCapacity> {
    const { body } = await this.arm<{ value?: Array<{ name?: { value?: string }; currentValue?: number; limit?: number }> }>(
      'GET',
      `/subscriptions/${this.options.subscriptionId}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=${COMPUTE_API}`,
    );
    const family = vmFamilyUsageName(this.options.vmSize);
    let used = 0;
    let limit = 0;
    let familyFree = Number.POSITIVE_INFINITY;
    for (const usage of body.value ?? []) {
      const name = usage.name?.value ?? '';
      if (name === 'cores') {
        used = usage.currentValue ?? 0;
        limit = usage.limit ?? 0;
      } else if (family !== null && name.toLowerCase() === family.toLowerCase()) {
        familyFree = (usage.limit ?? 0) - (usage.currentValue ?? 0);
      }
    }
    // The tighter of the regional total and the size's own family quota.
    const free = Math.min(limit - used, familyFree);
    return { usedCores: limit - free, limitCores: limit };
  }
}

/** The usage counter a size's family is billed against, e.g. Standard_B2ats_v2 -> standardBASv2Family. */
export function vmFamilyUsageName(size: string): string | null {
  const match = size.match(/^Standard_B\d+([a-z]*)_v(\d)$/i);
  if (match === null) return null;
  const letters = (match[1] ?? '').toLowerCase();
  // B-series v2: "ls"/"s" -> BSv2, "als"/"as"/"ats" -> BASv2, "pls"/"ps"/"pts" -> BPSv2.
  const flavour = letters.startsWith('a') ? 'AS' : letters.startsWith('p') ? 'PS' : 'S';
  return `standardB${flavour}v${match[2]}Family`;
}
