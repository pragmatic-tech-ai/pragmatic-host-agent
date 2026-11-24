import { PlacementResult, PlacementState, ProtocolNames, type PlacementResultJson } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/**
 * The next thing a placement needs, in order for a Place: `cluster` -> `engine` -> `enrolment` -> `credential` ->
 * `placed`. `upgrade` is a placed hive whose engine version or chart digest changed (helm upgrade only), `removing` a
 * Remove not finished yet; `removed` and `failed` are final.
 */
export enum PlacementStep
{
    Cluster = 'cluster',
    Engine = 'engine',
    Enrolment = 'enrolment',
    Credential = 'credential',
    Placed = 'placed',
    Upgrade = 'upgrade',
    Removing = 'removing',
    Removed = 'removed',
    Failed = 'failed',
}

export interface PlacementRecordJson
{
    PlacementId: string
    Tenant: string
    Step: PlacementStep
    EngineVersion: string | null
    ChartDigest: string | null
    HiveHostName: string | null
    /** The engine version and chart digest helm last installed (null before the engine step). */
    InstalledVersion: string | null
    InstalledDigest: string | null
    /** The hosted hive's one-time code until the engine step wrote it into the cluster's Secret; then null. */
    EnrolmentCode: string | null
    /** The API-server port, held from the cluster step until the cluster is removed. */
    Port: number | null
    /** The last credential handover's rotation number (0: none yet) and when it was issued. */
    Rotation: number
    CredentialIssuedAt: string | null
    /** Times the current step failed in a row (a step is retried a bounded number of times before the placement fails). */
    Attempts: number
    /** The result to send (retried until the platform acknowledges it), or null when none is pending. */
    PendingResult: PlacementResultJson | null
}

/** One placement on this machine, as `<state dir>/placements/<id>.json` keeps it. */
export class PlacementRecord
{
    public static readonly Steps: readonly PlacementStep[] = Object.values(PlacementStep)
    /** The steps whose placement holds a slot (and, once its cluster exists, a port). */
    private static readonly Active: ReadonlySet<PlacementStep> = new Set([
        PlacementStep.Cluster, PlacementStep.Engine, PlacementStep.Enrolment, PlacementStep.Credential, PlacementStep.Placed, PlacementStep.Upgrade, PlacementStep.Removing,
    ])
    private static readonly States: ReadonlyMap<PlacementStep, PlacementState> = new Map([
        [PlacementStep.Cluster, PlacementState.CreatingCluster],
        [PlacementStep.Engine, PlacementState.InstallingEngine],
        [PlacementStep.Upgrade, PlacementState.InstallingEngine],
        [PlacementStep.Enrolment, PlacementState.Enrolling],
        [PlacementStep.Credential, PlacementState.Enrolling],
        [PlacementStep.Placed, PlacementState.Running],
        [PlacementStep.Failed, PlacementState.Failed],
        [PlacementStep.Removing, PlacementState.Removing],
    ])

    public constructor(public readonly Json: PlacementRecordJson)
    {
    }

    public static Parse(value: unknown): PlacementRecord | undefined
    {
        if (typeof value !== 'object' || value === null)
        {
            return undefined
        }
        const json = value as PlacementRecordJson
        if (typeof json.PlacementId !== 'string' || !ProtocolNames.Label.test(json.PlacementId) || !PlacementRecord.Steps.includes(json.Step)
            || typeof json.Tenant !== 'string' || typeof json.Rotation !== 'number' || typeof json.Attempts !== 'number')
        {
            return undefined
        }
        if (json.PendingResult !== null)
        {
            try
            {
                PlacementResult.Parse(json.PendingResult)
            }
            catch
            {
                return undefined
            }
        }
        return new PlacementRecord(json)
    }

    public get Id(): string
    {
        return this.Json.PlacementId
    }

    public get Step(): PlacementStep
    {
        return this.Json.Step
    }

    /** Whether the placement holds one of the machine's hive slots. */
    public get Active(): boolean
    {
        return PlacementRecord.Active.has(this.Json.Step)
    }

    /** The protocol state a capacity report shows for it; undefined once removed. */
    public get State(): PlacementState | undefined
    {
        return PlacementRecord.States.get(this.Json.Step)
    }

    public With(changes: Partial<PlacementRecordJson>): PlacementRecord
    {
        return new PlacementRecord({ ...this.Json, ...changes })
    }
}
