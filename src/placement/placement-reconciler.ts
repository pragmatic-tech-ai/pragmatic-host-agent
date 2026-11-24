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
import { PlacementRecordUnreadableError, type PlacementStore } from './placement-store.js'

/** The hosted hive did not write its enrolment ConfigMap by its recorded deadline. */
export class HostedEnrolmentTimeoutError extends Error
{
    private static readonly ErrorName = 'HostedEnrolmentTimeoutError'
    private static readonly Text = 'the hosted hive did not enrol by its deadline (ConfigMap pragmatic-system/pragmatic-hive-enrolment)'

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

/** What a pulled request did: recorded, ignored (older or the same version, or a finished placement), or not taken now. */
export enum AcceptOutcome
{
    Recorded = 'recorded',
    Ignored = 'ignored',
    /** The placement is being worked on: the request is taken on a later pull (the cursor stays before it). */
    Busy = 'busy',
}

/** One critical section at a time (the slot and port allocation). */
export class AsyncMutex
{
    private tail: Promise<void> = Promise.resolve()

    public async Run<T>(section: () => Promise<T>): Promise<T>
    {
        const previous = this.tail
        let release!: () => void
        this.tail = new Promise(resolve => { release = resolve })
        await previous
        try
        {
            return await section()
        }
        finally
        {
            release()
        }
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
    Logger?: ILogger
}

/**
 * Brings each placement on the machine to what the platform asked (C5.1 Task 2). A Place runs `cluster` (a slot and a
 * port under one lock, else failed no-capacity; the kind cluster) -> `engine` (the code Secret, the code then dropped
 * from the record, helm upgrade --install) -> `enrolment` (the hosted hive's ConfigMap checked once per pass until a
 * recorded deadline, never blocking other placements) -> `credential` (the sealed handover) -> `placed`, every step
 * recorded before the next starts, so a restart resumes at the step it stopped at and every step's work is idempotent
 * (Review Focus 1). Placements run concurrently, one run per placement at a time; a request for a placement being
 * worked on waits for a later pull. Requests carry the placement version: an older or the same version changes nothing.
 * A newer Place for a placed hive with another engine version or chart digest is an upgrade (helm upgrade --atomic only,
 * never the code Secret). A Remove deletes the cluster, its charts and files and frees its port and slot; a Remove for a
 * placement the machine does not hold answers removed (Review Focus 4). A failing step is retried on the next pass,
 * failing the placement (its cluster deleted, its port freed) after `MaxAttempts`. Results carry the version they answer
 * and are kept until the platform acknowledges them; a finished placement's file is then pruned (its tombstone kept).
 */
export class PlacementReconciler
{
    public static readonly MaxAttempts = 3
    /** How long a hosted hive has to enrol once its engine is installed. */
    public static readonly EnrolmentTimeoutMs = 15 * 60 * 1000
    public static readonly EnrolmentConfigMap = 'pragmatic-hive-enrolment'
    private static readonly HostLabelSeparator = '.'
    private static readonly StepFailed = 'placement step failed'
    private static readonly RunFailed = 'placement run failed'
    private static readonly ResultFailed = 'placement result not delivered'
    private static readonly RotationFailed = 'credential rotation failed'
    private static readonly UnreadableRequest = 'a request names an unreadable placement file'
    private static readonly RemoveKey = 'remove'
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
        [PlacementStep.Credential, PlacementFailure.CredentialFailed],
        [PlacementStep.Removing, PlacementFailure.RemoveFailed],
    ])
    private static readonly Work: ReadonlySet<PlacementStep> = new Set([
        PlacementStep.Cluster, PlacementStep.Engine, PlacementStep.Enrolment, PlacementStep.Credential, PlacementStep.Upgrade, PlacementStep.Removing,
    ])
    private readonly logger: ILogger
    private readonly running = new Map<string, Promise<unknown>>()
    private readonly allocation = new AsyncMutex()

    public constructor(private readonly options: PlacementReconcilerOptions)
    {
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
    public async Accept(request: PlacementRequest): Promise<AcceptOutcome>
    {
        if (this.running.has(request.PlacementId))
        {
            return AcceptOutcome.Busy
        }
        const outcome = await this.Exclusive(request.PlacementId, () => this.Record(request))
        return outcome ?? AcceptOutcome.Busy
    }

    /** Starts a run for every placement with work left that is not running already; does not wait for them. */
    public async Kick(): Promise<void>
    {
        const P = PlacementReconciler
        for (const record of await this.options.Store.All())
        {
            if (P.Work.has(record.Step) && !this.running.has(record.Id))
            {
                this.Run(record.Id).catch(error => this.logger.Error(P.RunFailed, { [P.PlacementKey]: record.Id, [P.ErrorKey]: P.MessageOf(error) }))
            }
        }
    }

    /** Runs every placement with work left (concurrently) and waits until each run ended. */
    public async RunAll(): Promise<void>
    {
        await this.Kick()
        await this.Idle()
    }

    /** Waits until no placement runs. */
    public async Idle(): Promise<void>
    {
        while (this.running.size > 0)
        {
            await Promise.allSettled([...this.running.values()])
        }
    }

    /** Runs one placement's steps from the recorded one until it is done, waits for the next pass, or failed. */
    public Run(placementId: string): Promise<PlacementRecord | undefined>
    {
        const current = this.running.get(placementId) as Promise<PlacementRecord | undefined> | undefined
        if (current !== undefined)
        {
            return current
        }
        return this.Exclusive(placementId, () => this.Steps(placementId)).then(record => record ?? undefined)
    }

    /** Sends every pending result of a placement not running; one acknowledged is cleared, a finished placement pruned. */
    public async SendResults(): Promise<void>
    {
        const P = PlacementReconciler
        for (const record of await this.options.Store.All())
        {
            if (record.Json.PendingResult === null)
            {
                if (record.Finished)
                {
                    await this.Exclusive(record.Id, () => this.options.Store.Prune(record))
                }
                continue
            }
            await this.Exclusive(record.Id, async () =>
            {
                const current = await this.options.Store.Get(record.Id)
                const pending = current?.Json.PendingResult ?? null
                if (current === undefined || pending === null)
                {
                    return
                }
                try
                {
                    await this.options.Channel.Notify(MessageKind.PlacementResult, PlacementResult.Parse(pending))
                }
                catch (error)
                {
                    this.logger.Warn(P.ResultFailed, { [P.PlacementKey]: record.Id, [P.ErrorKey]: P.MessageOf(error) })
                    return
                }
                const acknowledged = current.With({ PendingResult: null })
                if (acknowledged.Finished)
                {
                    await this.options.Store.Prune(acknowledged)
                    return
                }
                await this.options.Store.Put(acknowledged)
            })
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
            await this.Exclusive(record.Id, async () =>
            {
                try
                {
                    await this.options.Store.Put(await this.HandOver(record))
                }
                catch (error)
                {
                    this.logger.Warn(P.RotationFailed, { [P.PlacementKey]: record.Id, [P.ErrorKey]: P.MessageOf(error) })
                }
            })
        }
    }

    /** Runs `section` holding the placement (no other run, accept, result or rotation for it meanwhile); undefined when held. */
    private async Exclusive<T>(placementId: string, section: () => Promise<T>): Promise<T | undefined>
    {
        if (this.running.has(placementId))
        {
            return undefined
        }
        const promise = section()
        this.running.set(placementId, promise)
        try
        {
            return await promise
        }
        finally
        {
            this.running.delete(placementId)
        }
    }

    private async Record(request: PlacementRequest): Promise<AcceptOutcome>
    {
        const P = PlacementReconciler
        const store = this.options.Store
        const remove = request.Operation === PlacementOperation.Remove
        let existing: PlacementRecord | undefined
        try
        {
            existing = await store.Get(request.PlacementId)
        }
        catch (error)
        {
            if (!(error instanceof PlacementRecordUnreadableError))
            {
                throw error
            }
            return this.Unreadable(request)
        }
        if (existing === undefined)
        {
            const tombstone = await store.TombstoneOf(request.PlacementId)
            if (tombstone !== undefined && (!remove || request.Version <= tombstone))
            {
                // A finished placement is never placed again, and an old removal is not answered twice.
                return AcceptOutcome.Ignored
            }
            const fresh = P.Fresh(request)
            await store.Put(remove ? fresh.With({ Step: PlacementStep.Removed, PendingResult: PlacementResult.Removed(request.PlacementId, request.Version).ToJson() }) : fresh)
            return AcceptOutcome.Recorded
        }
        if (request.Version <= existing.Json.Version)
        {
            // The same version again (a re-delivery) or an older one delivered late: nothing new.
            return AcceptOutcome.Ignored
        }
        const version = request.Version
        if (remove)
        {
            if (existing.Step === PlacementStep.Removed || (existing.Step === PlacementStep.Failed && existing.Json.Port === null))
            {
                await store.Put(existing.With({ Version: version, Step: PlacementStep.Removed, PendingResult: PlacementResult.Removed(request.PlacementId, version).ToJson() }))
            }
            else
            {
                await store.Put(existing.With({ Version: version, Step: PlacementStep.Removing, Attempts: 0, EnrolmentCode: null, EnrolmentDeadline: null }))
            }
            return AcceptOutcome.Recorded
        }
        if (existing.Step === PlacementStep.Removed || existing.Step === PlacementStep.Removing || existing.Step === PlacementStep.Failed)
        {
            // A placement once removed or failed is never placed again under the same id.
            return AcceptOutcome.Ignored
        }
        // The code of a later request was redeemed by the first install already: it is never written again.
        const target = { Version: version, EngineVersion: request.EngineVersion, ChartDigest: request.ChartDigest, HiveHostName: request.HiveHostName }
        if (existing.Step === PlacementStep.Placed)
        {
            const changed = request.EngineVersion !== existing.Json.InstalledVersion || request.ChartDigest !== existing.Json.InstalledDigest
            const next = existing.With(target)
            await store.Put(changed ? next.With({ Step: PlacementStep.Upgrade, Attempts: 0 }) : next.With({ PendingResult: this.Placed(next).ToJson() }))
            return AcceptOutcome.Recorded
        }
        // Not placed yet: the steps still to run install what the newest request names.
        await store.Put(existing.With(target))
        return AcceptOutcome.Recorded
    }

    /**
     * A request for a placement whose file does not read (M20): a Remove deletes its cluster and charts (best effort) and
     * answers removed, replacing the file; a Place is ignored (the capacity report shows the placement failed, what it
     * holds is unknown). Either way the request is taken, so the pull cursor moves past it.
     */
    private async Unreadable(request: PlacementRequest): Promise<AcceptOutcome>
    {
        const P = PlacementReconciler
        const remove = request.Operation === PlacementOperation.Remove
        this.logger.Error(P.UnreadableRequest, { [P.PlacementKey]: request.PlacementId, [P.RemoveKey]: remove })
        if (!remove)
        {
            return AcceptOutcome.Ignored
        }
        const name = ClusterNames.For(request.PlacementId)
        try
        {
            await this.options.Driver.Delete(name)
            await this.options.Engine.Forget(name)
        }
        catch (error)
        {
            this.logger.Warn(P.StepFailed, { [P.PlacementKey]: request.PlacementId, [P.StepKey]: PlacementStep.Removing, [P.ErrorKey]: P.MessageOf(error) })
        }
        await this.options.Store.Put(P.Fresh(request).With({ Step: PlacementStep.Removed, PendingResult: PlacementResult.Removed(request.PlacementId, request.Version).ToJson() }))
        return AcceptOutcome.Recorded
    }

    private async Steps(placementId: string): Promise<PlacementRecord | undefined>
    {
        const store = this.options.Store
        let record: PlacementRecord | undefined
        try
        {
            record = await store.Get(placementId)
        }
        catch (error)
        {
            if (error instanceof PlacementRecordUnreadableError)
            {
                return undefined
            }
            throw error
        }
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
                // What the step recorded before it failed (a port, the code dropped, a rotation number claimed) stands.
                next = await this.StepFailed(await store.Get(placementId) ?? record, error)
                await store.Put(next)
                if (next.Step === step)
                {
                    return next
                }
                record = next
                continue
            }
            await store.Put(next)
            if (next.Step === step)
            {
                // Waiting (the hosted hive's enrolment): looked at again on the next pass.
                return next
            }
            record = next
        }
        return record
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
                return this.CheckEnrolment(record)
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
        // Slots and ports are counted and taken under one lock: two placements starting together never share a port.
        const held = await this.allocation.Run(async () =>
        {
            const all = await o.Store.All()
            // A slot is held from the port on: a fresh request still waiting for its own allocation holds none, so N
            // requests started together on N free slots all get one.
            const others = all.filter(other => other.Id !== record.Id && other.Active && other.Json.Port !== null).length
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
            const withPort = record.With({ Port: port })
            await o.Store.Put(withPort)
            return withPort
        })
        await o.Driver.Create(this.SpecOf(held))
        return held.With({ Step: PlacementStep.Engine, Attempts: 0 })
    }

    private async InstallEngine(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        const access = await o.Driver.Access(ClusterNames.For(record.Id))
        let current = record
        const code = record.Json.EnrolmentCode
        if (code !== null)
        {
            await o.Engine.WriteCode(o.Kube.For(access), code)
            // The code is in the cluster now: it leaves the record before anything else runs.
            current = record.With({ EnrolmentCode: null })
            await o.Store.Put(current)
        }
        await o.Engine.Install(access, this.TargetOf(current))
        const deadline = new Date(o.Clock.Now().getTime() + PlacementReconciler.EnrolmentTimeoutMs).toISOString()
        return current.With({
            Step: PlacementStep.Enrolment, Attempts: 0, EnrolmentDeadline: deadline,
            InstalledVersion: current.Json.EngineVersion, InstalledDigest: current.Json.ChartDigest,
        })
    }

    /** One look at the hosted hive's enrolment: on, waiting (the record unchanged), or past its deadline. */
    private async CheckEnrolment(record: PlacementRecord): Promise<PlacementRecord>
    {
        const o = this.options
        const kube = o.Kube.For(await o.Driver.Access(ClusterNames.For(record.Id)))
        if (await kube.ConfigMapExists(EngineInstaller.Namespace, PlacementReconciler.EnrolmentConfigMap))
        {
            return record.With({ Step: PlacementStep.Credential, Attempts: 0, EnrolmentDeadline: null })
        }
        const deadline = record.Json.EnrolmentDeadline
        if (deadline !== null && o.Clock.Now().getTime() >= Date.parse(deadline))
        {
            throw new HostedEnrolmentTimeoutError()
        }
        if (deadline === null)
        {
            return record.With({ EnrolmentDeadline: new Date(o.Clock.Now().getTime() + PlacementReconciler.EnrolmentTimeoutMs).toISOString() })
        }
        return record
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
        const name = ClusterNames.For(record.Id)
        await this.options.Driver.Delete(name)
        await this.options.Engine.Forget(name)
        return record.With({
            Step: PlacementStep.Removed, Port: null, Attempts: 0, EnrolmentCode: null, EnrolmentDeadline: null,
            PendingResult: PlacementResult.Removed(record.Id, record.Json.Version).ToJson(),
        })
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
        const final = capacity || error instanceof HostedEnrolmentTimeoutError
        const attempts = record.Json.Attempts + 1
        if (!final && attempts < P.MaxAttempts)
        {
            return record.With({ Attempts: attempts })
        }
        const version = record.Json.Version
        const failure = capacity ? PlacementFailure.NoCapacity : P.StepFailures.get(record.Step) ?? PlacementFailure.ClusterCreateFailed
        const failed = PlacementResult.Failed(record.Id, version, failure).ToJson()
        if (record.Step === PlacementStep.Removing)
        {
            // Removal keeps trying; the platform hears it failed so far.
            return record.With({ Attempts: 0, PendingResult: failed })
        }
        if (record.Step === PlacementStep.Upgrade)
        {
            // helm rolled the release back (--atomic): the hive keeps running its installed engine.
            return record.With({
                Step: PlacementStep.Placed, Attempts: 0, PendingResult: failed,
                EngineVersion: record.Json.InstalledVersion, ChartDigest: record.Json.InstalledDigest,
            })
        }
        if (!capacity || record.Json.Port !== null)
        {
            const name = ClusterNames.For(record.Id)
            try
            {
                await this.options.Driver.Delete(name)
                await this.options.Engine.Forget(name)
            }
            catch (cleanup)
            {
                this.logger.Warn(P.StepFailed, { [P.PlacementKey]: record.Id, [P.StepKey]: PlacementStep.Removing, [P.ErrorKey]: P.MessageOf(cleanup) })
                // Keep the port held until the cluster is gone: removing it is retried as a removal.
                return record.With({ Step: PlacementStep.Removing, Attempts: 0, EnrolmentCode: null, EnrolmentDeadline: null, PendingResult: failed })
            }
        }
        return record.With({ Step: PlacementStep.Failed, Port: null, Attempts: 0, EnrolmentCode: null, EnrolmentDeadline: null, PendingResult: failed })
    }

    private Placed(record: PlacementRecord): PlacementResult
    {
        return PlacementResult.Placed(record.Id, record.Json.Version, new ApiServerAddress(this.options.MeshAddress, record.Json.Port as number))
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
            Version: request.Version,
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
            EnrolmentDeadline: null,
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
