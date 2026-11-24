import { ClusterKind, PlacementRequest, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HostChannel } from '../../channel/host-channel.js'
import { ClusterAccess, type ClusterSpec, type IClusterDriver } from '../../cluster/cluster-driver.js'
import { PortAllocator, type IPortProbe } from '../../cluster/port-allocator.js'
import { ClusterCredentialIssuer } from '../../credential/cluster-credential-issuer.js'
import { HostEnrolment } from '../../enrolment/host-enrolment.js'
import { HostEnrolmentStore, type HostEnrolmentState } from '../../enrolment/host-enrolment-state.js'
import { EngineInstaller } from '../../engine/engine-installer.js'
import type { IHostedKube, IHostedKubeFactory } from '../../kube/hosted-kube.js'
import { PortRange } from '../../settings/host-settings.js'
import { FakeProcessRunner, TempState } from '../../tests/fakes.js'
import type { PlacementRecord } from '../placement-record.js'
import { PlacementReconciler } from '../placement-reconciler.js'
import { PlacementStore } from '../placement-store.js'

/** IClusterDriver in memory: which clusters exist and how often each operation ran. */
export class FakeClusterDriver implements IClusterDriver
{
    public readonly Kind = ClusterKind.Kind
    public readonly Clusters = new Map<string, ClusterSpec>()
    public readonly Creates: ClusterSpec[] = []
    public readonly Deletes: string[] = []
    public FailCreate = false
    public FailDelete = false

    public Create(spec: ClusterSpec): Promise<ClusterAccess>
    {
        this.Creates.push(spec)
        if (this.FailCreate)
        {
            return Promise.reject(new Error('kind create failed'))
        }
        this.Clusters.set(spec.Name, spec)
        return Promise.resolve(new ClusterAccess(spec.Name, '/state/clusters/' + spec.Name + '/kubeconfig'))
    }

    public Access(name: string): Promise<ClusterAccess>
    {
        if (!this.Clusters.has(name))
        {
            return Promise.reject(new Error('no such cluster ' + name))
        }
        return Promise.resolve(new ClusterAccess(name, '/state/clusters/' + name + '/kubeconfig'))
    }

    public Delete(name: string): Promise<void>
    {
        this.Deletes.push(name)
        if (this.FailDelete)
        {
            return Promise.reject(new Error('kind delete failed'))
        }
        this.Clusters.delete(name)
        return Promise.resolve()
    }
}

/** IHostedKube of one cluster over the shared FakeHostedKube. */
export class FakeClusterKube implements IHostedKube
{
    public constructor(private readonly shared: FakeHostedKube, private readonly cluster: string)
    {
    }

    public Apply(manifest: unknown): Promise<void>
    {
        this.shared.Applied.push({ Cluster: this.cluster, Manifest: manifest })
        return Promise.resolve()
    }

    public ConfigMapExists(): Promise<boolean>
    {
        this.shared.Polls += 1
        return Promise.resolve(this.shared.Enrolled && !this.shared.NotEnrolled.has(this.cluster))
    }

    public CreateToken(): Promise<string>
    {
        if (this.shared.FailTokens)
        {
            return Promise.reject(new Error('TokenRequest refused'))
        }
        const token = 'token-' + (this.shared.Tokens.length + 1)
        this.shared.Tokens.push(token)
        return Promise.resolve(token)
    }

    public CertificateAuthority(): Promise<string>
    {
        return Promise.resolve(FakeHostedKube.CertificateAuthorityData)
    }
}

/** IHostedKube in memory, shared by every cluster: the manifests applied, the tokens issued, the enrolment ConfigMaps. */
export class FakeHostedKube implements IHostedKubeFactory
{
    public static readonly CertificateAuthorityData = Buffer.from('-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n').toString('base64')
    public readonly Applied: { Cluster: string; Manifest: unknown }[] = []
    public readonly Tokens: string[] = []
    /** Clusters whose hosted hive has not enrolled (yet). */
    public readonly NotEnrolled = new Set<string>()
    public Enrolled = true
    public FailTokens = false
    public Polls = 0

    public For(access: ClusterAccess): IHostedKube
    {
        return new FakeClusterKube(this, access.Name)
    }

    /** A kube for tests that call it directly (cluster `direct`). */
    public Direct(): IHostedKube
    {
        return new FakeClusterKube(this, 'direct')
    }

    /** The Secrets applied, as kind/name/namespace/data. */
    public Secrets(): { name: string; namespace: string; data: Record<string, string> }[]
    {
        const secrets: { name: string; namespace: string; data: Record<string, string> }[] = []
        for (const entry of this.Applied)
        {
            for (const item of (entry.Manifest as { items: { kind: string; metadata: { name: string; namespace: string }; data: Record<string, string> }[] }).items)
            {
                if (item.kind === 'Secret')
                {
                    secrets.push({ name: item.metadata.name, namespace: item.metadata.namespace, data: item.data })
                }
            }
        }
        return secrets
    }
}

/** A port probe that reports the listed ports as taken by something else. */
export class FakePortProbe implements IPortProbe
{
    public readonly Busy = new Set<number>()

    public IsFree(port: number): Promise<boolean>
    {
        return Promise.resolve(!this.Busy.has(port))
    }
}

/** When the simulated process dies around its `killAt`-th write: right after it landed, or right before (it never lands). */
export enum KillPoint
{
    AfterWrite = 'after',
    BeforeWrite = 'before',
}

/**
 * Every write fails from the `killAt`-th on: the process died right after that write landed (AfterWrite) or right
 * before it (BeforeWrite: it never lands). Nothing written after the kill lands either.
 */
export class KillingStore extends PlacementStore
{
    public static readonly Killed = 'killed'
    public Writes = 0

    public constructor(files: TempState['Files'], private readonly killAt: number, private readonly point: KillPoint = KillPoint.AfterWrite)
    {
        super(files)
    }

    public override async Put(record: PlacementRecord): Promise<void>
    {
        this.Writes += 1
        if (this.Writes > this.killAt || (this.Writes === this.killAt && this.point === KillPoint.BeforeWrite))
        {
            throw new Error(KillingStore.Killed)
        }
        await super.Put(record)
        if (this.Writes === this.killAt)
        {
            throw new Error(KillingStore.Killed)
        }
    }

    public override async Prune(record: PlacementRecord): Promise<void>
    {
        if (this.Writes >= this.killAt)
        {
            throw new Error(KillingStore.Killed)
        }
        await super.Prune(record)
    }
}

/**
 * One enrolled host over a FakePlatform, with a fake cluster driver, a fake kube, a fake process runner as helm (its
 * `helm pull` answers the chart digest) and a real PlacementStore in a temporary state directory.
 */
export class PlacementFixture
{
    public static readonly Mesh = '100.64.0.7'
    public static readonly Tenant = 'acme'
    public static readonly HiveHost = 'acme-ab2c.hives.pragmatic-tech.ai'
    public static readonly Version = '0.1.0-early.20'
    public static readonly NewVersion = '0.1.0-early.21'
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly NewDigest = 'sha256:' + 'b'.repeat(64)
    public readonly Platform = new FakePlatform()
    public readonly Wire = new FakeAgentChannel(this.Platform)
    public readonly Key = SigningKeyPair.Generate()
    public readonly State = new TempState()
    public readonly Driver = new FakeClusterDriver()
    public readonly Kube = new FakeHostedKube()
    public readonly Helm = new FakeProcessRunner()
    public readonly Probe = new FakePortProbe()
    public Enrolment!: HostEnrolmentState
    public Channel!: HostChannel
    public ChartDigests = new Map<string, string>([[PlacementFixture.Version, PlacementFixture.Digest], [PlacementFixture.NewVersion, PlacementFixture.NewDigest]])

    public static async Enrolled(): Promise<PlacementFixture>
    {
        const f = new PlacementFixture()
        const root = f.Platform.TrustRoot
        f.Enrolment = await new HostEnrolment({
            Key: f.Key, Channel: f.Wire, Store: new HostEnrolmentStore(f.State.Files, root), PinnedTrustRoot: root,
            MachineName: 'hive-laptop', MeshAddress: PlacementFixture.Mesh, AgentVersion: '0.1.0', Clock: f.Platform.Clock,
        }).Enrol(f.Platform.IssueHostCode())
        f.Channel = new HostChannel(f.Key, f.Enrolment, f.Wire, f.Platform.Clock)
        f.Helm.On(command => command.Program === 'helm' && command.Args[0] === 'pull', command =>
        {
            const version = command.Args[command.Args.indexOf('--version') + 1]
            return FakeProcessRunner.Ok('Pulled: ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine:' + version + '\nDigest: ' + (f.ChartDigests.get(version) ?? 'sha256:' + 'f'.repeat(64)) + '\n')
        })
        return f
    }

    public Store(): PlacementStore
    {
        return new PlacementStore(this.State.Files)
    }

    public Reconciler(options: { Store?: PlacementStore; Slots?: number; Ports?: string } = {}): PlacementReconciler
    {
        return new PlacementReconciler({
            Store: options.Store ?? this.Store(),
            Driver: this.Driver,
            Ports: new PortAllocator(PortRange.Parse(options.Ports ?? '16444-16463') as PortRange, this.Probe),
            Engine: new EngineInstaller(this.Helm, this.State.Files),
            Kube: this.Kube,
            Credentials: new ClusterCredentialIssuer(this.Platform.Clock),
            Channel: this.Channel,
            SealingKey: this.Enrolment.SealingKey,
            MeshAddress: PlacementFixture.Mesh,
            HiveSlots: options.Slots ?? 4,
            Clock: this.Platform.Clock,
        })
    }

    public static Place(id: string, version: string = PlacementFixture.Version, digest: string = PlacementFixture.Digest, code: string = 'one-time-code-' + id + '-0123456789', placementVersion: number = 1): PlacementRequest
    {
        const F = PlacementFixture
        return PlacementRequest.Place({ PlacementId: id, Version: placementVersion, Tenant: F.Tenant, EnrolmentCode: code, EngineVersion: version, ChartDigest: digest, HiveHostName: F.HiveHost })
    }

    public static Remove(id: string, placementVersion: number = 2): PlacementRequest
    {
        return PlacementRequest.Remove(id, PlacementFixture.Tenant, placementVersion)
    }

    /** The helm argument vectors run, the program first. */
    public HelmRuns(verb: string): string[][]
    {
        return this.Helm.Argvs.filter(argv => argv[0] === 'helm' && argv[1] === verb)
    }

    public Dispose(): void
    {
        this.State.Dispose()
    }
}
