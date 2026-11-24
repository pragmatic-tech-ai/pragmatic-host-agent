import {
    ApiServerAddress, MessageKind, PlacementFailure, PlacementOperation, PlacementResult, type IProtocolClock, type PlacementRequest, type SealingPublicKey,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { ClusterNames, ClusterSpec, type IClusterDriver } from '../cluster/cluster-driver.js'
import { NoFreePortError, type PortAllocator } from '../cluster/port-allocator.js'
import { CredentialSubject, type ClusterCredentialIssuer } from '../credential/cluster-credential-issuer.js'
import { EngineInstaller, EngineTarget } from '../engine/engine-installer.js'
import type { IHostedKubeFactory } from '../kube/hosted-kube.js'
import type { HostChannel } from '../channel/host-channel.js'
import { PlacementRecord, PlacementStep, type PlacementRecordJson } from './placement-record.js'
import type { PlacementStore } from './placement-store.js'

/** Waits between two polls (the hosted hive's enrolment); faked in tests. */
export interface IDelay
{
    Wait(ms: number): Promise<void>
}

export class TimerDelay implements IDelay
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/** The hosted hive did not write its enrolment ConfigMap within the bound. */
export class HostedEnrolmentTimeoutError extends Error
{
    private static readonly ErrorName = 'HostedEnrolmentTimeoutError'
    private static readonly Text = 'the hosted hive did not enrol within the bound (ConfigMap pragmatic-system/pragmatic-hive-enrolment)'

    public constructor()
    {
        super(HostedEnrolmentTimeoutError.Text)
        this.name = HostedEnrolmentTimeoutError.ErrorName
    }
}

/** A Place with no capacity left: a refusal, not a failure to retry. */
class NoCapacityError extends Error
{
    private static readonly ErrorName = 'NoCapacityError'
    private static readonly Text = 'the host has no free hive slot or API-server port'

    public constructor()
    {
        super(NoCapacityError.Text)
        this.name = NoCapacityError.ErrorName
    }
}

export interface PlacementReconcilerOptions
{
    Store: PlacementStore
    Driver: IClusterDriver
    Ports: PortAllocator
    Engine: EngineInstaller
    Kube: IHostedKubeFactory
    Credentials: ClusterCredentialIssuer
    Channel: HostChannel
    SealingKey: SealingPublicKey
    MeshAddress: string
    HiveSlots: number
    Clock: IProtocolClock
    Delay?: IDelay
    Logger?: ILogger
}

/**
 * Brings each placement on the machine to what the platform asked (C5.1 Task 2). A Place runs `cluster` (a slot and a
 * port, else failed no-capacity; the kind cluster) -> `engine` (the code Secret, helm upgrade --install) -> `enrolment`
 * (until the hosted hive's ConfigMap pragmatic-system/pragmatic-hive-enrolment exists, bounded) -> `credential` (the
 * sealed handover, rotation 1) -> `placed` (the result), every step recorded in `placements/<id>.json` before the next
 * starts, so a restart resumes at the step it stopped at and every step's work is idempotent (Review Focus 1). A Place
 * for a placed hive with another engine version or chart digest is an upgrade (helm upgrade only); the same one answers
 * placed again. A Remove deletes the cluster and frees its port and slot, and a Remove for a placement the machine does
 * not hold answers removed (Review Focus 4). A failing step is retried on the next pass, failing the placement (its
 * cluster deleted, its port freed) after `MaxAttempts`. Results are kept until the platform acknowledges them.
 */
export class PlacementReconciler
{
    public static readonly MaxAttempts = 3
    public static readonly EnrolmentPollMs = 10_000
    public static readonly EnrolmentPolls = 60
    public static readonly EnrolmentConfigMap = 'pragmatic-hive-enrolment'
    private static readonly HostLabelSeparator = '.'
    private static readonly StepFailed = 'placement step failed'
    private static readonly ResultFailed = 'placement result not delivered'
    private static readonly RotationFailed = 'credential rotation failed'
    private static readonly PlacementKey = 'placementId'
    private static readonly StepKey = 'step'
    private static readonly ErrorKey = 'error'
    private static readonly Unknown = 'unknown error'
    /** The failure code a placement gets when this step runs out of attempts. */
    private static readonly StepFailures: ReadonlyMap<PlacementStep, PlacementFailure> = new Map([
        [PlacementStep.Cluster, PlacementFailure.ClusterCreateFailed],
        [PlacementStep.Engine, PlacementFailure.EngineInstallFailed],
        [PlacementStep.Upgrade, PlacementFailure.EngineInstallFailed],
        [PlacementStep.Enrolment, PlacementFailure.EnrolmentFailed],
        [PlacementStep.Credential, PlacementFailure.EnrolmentFailed],
        [PlacementStep.Removing, PlacementFailure.RemoveFailed],
    ])
    private static readonly Work: ReadonlySet<PlacementStep> = new Set([
        PlacementStep.Cluster, PlacementStep.Engine, PlacementStep.Enrolment, PlacementStep.Credential, PlacementStep.Upgrade, PlacementStep.Removing,
    ])
    private readonly delay: IDelay
    private readonly logger: ILogger

    public constructor(private readonly options: PlacementReconcilerOptions)
    {
        this.delay = options.Delay ?? new TimerDelay()
        this.logger = options.Logger ?? new NullLogger()
    }

    /** Records a verified request and runs its placement as far as it goes now; answers the result it reached. */
    public async Reconcile(request: PlacementRequest): Promise<PlacementResult | undefined>
    {
        await this.Accept(request)
        const record = await this.Run(request.PlacementId)
        const pending = record?.Json.PendingResult ?? null
        return pending === null ? undefined : PlacementResult.Parse(pending)
    }

    /** What a pulled, verified request changes on record (the work itself runs in `Run`). */
    public async Accept(request: PlacementRequest): Promise<void>
    {
        const store = this.options.Store
        const existing = await store.Get(request.PlacementId)
        if (request.Operation === PlacementOperation.Remove)
        {
            if (existing === undefined)
            {
                await store.Put(PlacementReconciler.Fresh(request).With({ Step: PlacementStep.Removed, PendingResult: PlacementResult.Removed(request.PlacementId).ToJson() }))
            }
            else if (existing.Step === PlacementStep.Removed || (existing.Step === PlacementStep.Failed && existing.Json.Port === null))
            {
                await store.Put(existing.With({ Step: PlacementStep.Removed, PendingResult: PlacementResult.Removed(request.PlacementId).ToJson() }))
            }
            else
            {
                await store.Put(existing.With({ Step: PlacementStep.Removing, Attempts: 0, EnrolmentCode: null }))
            }
            return
        }
        if (existing === undefined)
        {
            await store.Put(PlacementReconciler.Fresh(request))
            return
        }
        if (existing.Step === PlacementStep.Removed || existing.Step === PlacementStep.Removing || existing.Step === PlacementStep.Failed)
        {
            // A placement once removed or failed is never placed again under the same id.
            return
        }
        const target = { EngineVersion: request.EngineVersion, ChartDigest: request.ChartDigest, HiveHostName: request.HiveHostName }
        if (existing.Step === PlacementStep.Placed)
        {
            const changed = request.EngineVersion !== existing.Json.InstalledVersion || request.ChartDigest !== existing.Json.InstalledDigest
            await store.Put(existing.With(changed
                ? { ...target, Step: PlacementStep.Upgrade, Attempts: 0 }
                : { PendingResult: this.Placed(existing).ToJson() }))
            return
        }
        // Not placed yet: the steps still to run install what the newest request names.
        await store.Put(existing.With(target))
    }

    /** Runs every placement with work left, oldest id first. */
    public async RunAll(): Promise<void>
    {
        for (const record of await this.options.Store.All())
        {
            if (PlacementReconciler.Work.has(record.Step))
            {
                await this.Run(record.Id)
            }
        }
    }

    /** Runs one placement's steps from the recorded one until it is done, waits for a retry, or failed. */
    public async Run(placementId: string): Promise<PlacementRecord | undefined>
    {
        const store = this.options.Store
        let record = await store.Get(placementId)
        while (record !== undefined && PlacementReconciler.Work.has(record.Step))
        {
            const step = record.Step
            let next: PlacementRecord
            try
            {
                next = await this.Step(record)
            }
            catch (error)
            {
                next = await this.StepFailed(record, error)
                await store.Put(next)
                if (next.Step === step)
                {
                    return next
                }
                record = next
                continue
            }
            await store.Put(next)
            record = next
        }
        return record
    }

    /** Sends every pending result; one acknowledged is cleared, one not is kept for the next pass. */
    public async SendResults(): Promise<void>
    {
        const P = PlacementReconciler
        for (const record of await this.options.Store.All())
        {
            const pending = record.Json.PendingResult
            if (pending === null)
            {
                continue
            }
            try
            {
                await this.options.Channel.Notify(MessageKind.PlacementResult, PlacementResult.Parse(pending))
            }
            catch (error)
            {
                this.logger.Warn(P.ResultFailed, { [P.PlacementKey]: record.Id, [P.ErrorKey]: P.MessageOf(error) })
                continue
            }
            const current = await this.options.Store.Get(record.Id)
            if (current !== undefined && JSON.stringify(current.Json.PendingResult) === JSON.stringify(pending))
            {
                await this.options.Store.Put(current.With({ PendingResult: null }))
            }
        }
    }

    /** Hands over a new credential for every placed hive whose last one is 3 days old (rotation number + 1). */
    public async RotateCredentials(): Promise<void>
    {
        const P = PlacementReconciler
        for (const record of await this.options.Store.All())
        {
            if (record.Step !== PlacementStep.Placed || !this.options.Credentials.RotationDue(record.Json.CredentialIssuedAt))
            {
                continue
            }
            try
            {
                await this.options.Store.Put(await this.HandOver(record))
            }
            catch (error)
            {
                this.logger.Warn(P.RotationFailed, { [P.PlacementKey]: record.Id, [P.ErrorKey]: P.MessageOf(error) })
            }
        }
    }

    private async Step(record: PlacementRecord): Promise<PlacementRecord>
    {
        switch (record.Step)
        {
            case PlacementStep.Cluster:
                return this.CreateCluster(record)
            case PlacementStep.Engine:
                return this.InstallEngine(record)
            case PlacementStep.Enrolment:
                return this.AwaitEnrolment(record)
            case PlacementStep.Credential:
            {
                const handed = await this.HandOver(record)
                return handed.With({ Step: PlacementStep.Placed, Attempts: 0, PendingResult: this.Placed(handed).ToJson() })
            }
            case PlacementStep.Upgrade:
                return this.UpgradeEngine(record)
            case PlacementStep.Removing:
                return this.Remove(record)
            default:
                return record
        }
    }

    private async CreateCluster(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        const all = await o.Store.All()
        const others = all.filter(other => other.Id !== record.Id && other.Active).length
        if (others >= o.HiveSlots)
        {
            throw new NoCapacityError()
        }
        let port: number
        try
        {
            port = await o.Ports.Allocate(record.Id, all)
        }
        catch (error)
        {
            throw error instanceof NoFreePortError ? new NoCapacityError() : error
        }
        // The port is recorded before the cluster is created: a restart re-creates it on the same one.
        const held = record.With({ Port: port })
        await o.Store.Put(held)
        await o.Driver.Create(this.SpecOf(held))
        return held.With({ Step: PlacementStep.Engine, Attempts: 0 })
    }

    private async InstallEngine(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        const access = await o.Driver.Access(ClusterNames.For(record.Id))
        const code = record.Json.EnrolmentCode
        if (code === null)
        {
            // The code was written into the cluster already (a restart after that): helm only.
            await o.Engine.Upgrade(access, this.TargetOf(record))
        }
        else
        {
            await o.Engine.Install(access, o.Kube.For(access), this.TargetOf(record), code)
        }
        return record.With({
            Step: PlacementStep.Enrolment, Attempts: 0, EnrolmentCode: null,
            InstalledVersion: record.Json.EngineVersion, InstalledDigest: record.Json.ChartDigest,
        })
    }

    private async AwaitEnrolment(record: PlacementRecord): Promise<PlacementRecord>
    {
        const P = PlacementReconciler
        const o = this.options
        const kube = o.Kube.For(await o.Driver.Access(ClusterNames.For(record.Id)))
        for (let poll = 0; poll < P.EnrolmentPolls; poll += 1)
        {
            if (await kube.ConfigMapExists(EngineInstaller.Namespace, P.EnrolmentConfigMap))
            {
                return record.With({ Step: PlacementStep.Credential, Attempts: 0 })
            }
            await this.delay.Wait(P.EnrolmentPollMs)
        }
        throw new HostedEnrolmentTimeoutError()
    }

    private async UpgradeEngine(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        await o.Engine.Upgrade(await o.Driver.Access(ClusterNames.For(record.Id)), this.TargetOf(record))
        const upgraded = record.With({ InstalledVersion: record.Json.EngineVersion, InstalledDigest: record.Json.ChartDigest })
        return upgraded.With({ Step: PlacementStep.Placed, Attempts: 0, PendingResult: this.Placed(upgraded).ToJson() })
    }

    private async Remove(record: PlacementRecord): Promise<PlacementRecord>
    {
        await this.options.Driver.Delete(ClusterNames.For(record.Id))
        return record.With({ Step: PlacementStep.Removed, Port: null, Attempts: 0, EnrolmentCode: null, PendingResult: PlacementResult.Removed(record.Id).ToJson() })
    }

    /** A new credential handed over (acknowledged), recorded with its rotation number and time. */
    private async HandOver(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        const kube = o.Kube.For(await o.Driver.Access(ClusterNames.For(record.Id)))
        // The rotation number is claimed on record before the handover goes out: one sent but not recorded (a restart
        // in between) is never sent again under the same number, which the platform would refuse as a replay.
        const rotation = record.Json.Rotation + 1
        const claimed = record.With({ Rotation: rotation })
        await o.Store.Put(claimed)
        const subject = new CredentialSubject(o.Channel.Self, record.Id, o.MeshAddress, record.Json.Port as number, o.SealingKey)
        const handover = await o.Credentials.Issue(kube, subject, rotation)
        await o.Channel.Notify(MessageKind.ClusterCredentialHandover, handover)
        return claimed.With({ CredentialIssuedAt: o.Clock.Now().toISOString() })
    }

    private async StepFailed(record: PlacementRecord, error: unknown): Promise<PlacementRecord>
    {
        const P = PlacementReconciler
        this.logger.Warn(P.StepFailed, { [P.PlacementKey]: record.Id, [P.StepKey]: record.Step, [P.ErrorKey]: P.MessageOf(error) })
        const capacity = error instanceof NoCapacityError
        const attempts = record.Json.Attempts + 1
        if (!capacity && attempts < P.MaxAttempts)
        {
            return record.With({ Attempts: attempts })
        }
        const failure = capacity ? PlacementFailure.NoCapacity : P.StepFailures.get(record.Step) ?? PlacementFailure.ClusterCreateFailed
        if (record.Step === PlacementStep.Removing)
        {
            // Removal keeps trying; the platform hears it failed so far.
            return record.With({ Attempts: 0, PendingResult: PlacementResult.Failed(record.Id, failure).ToJson() })
        }
        if (record.Step === PlacementStep.Upgrade)
        {
            // The hive keeps running its installed engine.
            return record.With({ Step: PlacementStep.Placed, Attempts: 0, PendingResult: PlacementResult.Failed(record.Id, failure).ToJson() })
        }
        if (!capacity || record.Json.Port !== null)
        {
            try
            {
                await this.options.Driver.Delete(ClusterNames.For(record.Id))
            }
            catch (cleanup)
            {
                this.logger.Warn(P.StepFailed, { [P.PlacementKey]: record.Id, [P.StepKey]: PlacementStep.Removing, [P.ErrorKey]: P.MessageOf(cleanup) })
                // Keep the port held until the cluster is gone: removing it is retried as a removal.
                return record.With({ Step: PlacementStep.Removing, Attempts: 0, EnrolmentCode: null, PendingResult: PlacementResult.Failed(record.Id, failure).ToJson() })
            }
        }
        return record.With({ Step: PlacementStep.Failed, Port: null, Attempts: 0, EnrolmentCode: null, PendingResult: PlacementResult.Failed(record.Id, failure).ToJson() })
    }

    private Placed(record: PlacementRecord): PlacementResult
    {
        return PlacementResult.Placed(record.Id, new ApiServerAddress(this.options.MeshAddress, record.Json.Port as number))
    }

    private SpecOf(record: PlacementRecord): ClusterSpec
    {
        const host = record.Json.HiveHostName ?? ''
        return new ClusterSpec(ClusterNames.For(record.Id), record.Json.Port as number, this.options.MeshAddress, host.split(PlacementReconciler.HostLabelSeparator)[0])
    }

    private TargetOf(record: PlacementRecord): EngineTarget
    {
        const j = record.Json
        return new EngineTarget(j.EngineVersion as string, j.ChartDigest as string, j.Tenant, j.HiveHostName as string)
    }

    private static Fresh(request: PlacementRequest): PlacementRecord
    {
        const json: PlacementRecordJson = {
            PlacementId: request.PlacementId,
            Tenant: request.Tenant,
            Step: PlacementStep.Cluster,
            EngineVersion: request.EngineVersion,
            ChartDigest: request.ChartDigest,
            HiveHostName: request.HiveHostName,
            InstalledVersion: null,
            InstalledDigest: null,
            EnrolmentCode: request.EnrolmentCode,
            Port: null,
            Rotation: 0,
            CredentialIssuedAt: null,
            Attempts: 0,
            PendingResult: null,
        }
        return new PlacementRecord(json)
    }

    private static MessageOf(error: unknown): string
    {
        return error instanceof Error ? error.message : PlacementReconciler.Unknown
    }
}
