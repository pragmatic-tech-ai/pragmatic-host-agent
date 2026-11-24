import { MessageKind } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { HostChannel } from './channel/host-channel.js'
import type { PlacementPuller } from './placement/placement-puller.js'
import type { PlacementReconciler } from './placement/placement-reconciler.js'
import type { CapacityReporter } from './report/capacity-reporter.js'

/** Runs one pass of work again and again, never two at once: the next pass starts `intervalMs` after one ended. */
export class RepeatingTask
{
    private stopped = false
    private timer: NodeJS.Timeout | undefined

    public constructor(private readonly intervalMs: number, private readonly pass: () => Promise<void>)
    {
    }

    public Start(): void
    {
        void this.Run()
    }

    public Stop(): void
    {
        this.stopped = true
        if (this.timer !== undefined)
        {
            clearTimeout(this.timer)
        }
    }

    private async Run(): Promise<void>
    {
        if (this.stopped)
        {
            return
        }
        await this.pass()
        if (!this.stopped)
        {
            this.timer = setTimeout(() => void this.Run(), this.intervalMs)
        }
    }
}

/**
 * The enrolled host's two loops (C5.1): the capacity report every 30 s on its own (so a placement that takes minutes
 * never makes the host look stale: the scheduler takes hosts reported within 2 min), and the placement work every
 * 30 s: pull, reconcile, send the pending results, rotate due credentials. A failing stage is logged by its message
 * and the others still run.
 */
export class HostAgentLoop
{
    public static readonly IntervalMs = 30_000
    private static readonly ReportFailed = 'capacity report failed'
    private static readonly PullFailed = 'placement pull failed'
    private static readonly ReconcileFailed = 'placement reconcile failed'
    private static readonly ResultsFailed = 'placement results failed'
    private static readonly RotationFailed = 'credential rotation failed'
    private static readonly ErrorKey = 'error'
    private static readonly Unknown = 'unknown error'
    private readonly reportTask: RepeatingTask
    private readonly workTask: RepeatingTask

    public constructor(
        private readonly channel: HostChannel,
        private readonly reporter: CapacityReporter,
        private readonly puller: PlacementPuller,
        private readonly reconciler: PlacementReconciler,
        private readonly logger: ILogger,
        intervalMs: number = HostAgentLoop.IntervalMs)
    {
        this.reportTask = new RepeatingTask(intervalMs, () => this.ReportOnce())
        this.workTask = new RepeatingTask(intervalMs, () => this.WorkOnce())
    }

    public Start(): void
    {
        this.reportTask.Start()
        this.workTask.Start()
    }

    public Stop(): void
    {
        this.reportTask.Stop()
        this.workTask.Stop()
    }

    public async ReportOnce(): Promise<void>
    {
        await this.Guard(HostAgentLoop.ReportFailed, async () => this.channel.Notify(MessageKind.HostReport, await this.reporter.Report()))
    }

    public async WorkOnce(): Promise<void>
    {
        const H = HostAgentLoop
        await this.Guard(H.PullFailed, async () => { await this.puller.Pull() })
        await this.Guard(H.ReconcileFailed, () => this.reconciler.RunAll())
        await this.Guard(H.ResultsFailed, () => this.reconciler.SendResults())
        await this.Guard(H.RotationFailed, () => this.reconciler.RotateCredentials())
    }

    private async Guard(failed: string, stage: () => Promise<void>): Promise<void>
    {
        try
        {
            await stage()
        }
        catch (error)
        {
            this.logger.Error(failed, { [HostAgentLoop.ErrorKey]: error instanceof Error ? error.message : HostAgentLoop.Unknown })
        }
    }
}
