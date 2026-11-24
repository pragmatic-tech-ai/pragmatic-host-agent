import { MessageKind } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { HostChannel } from './channel/host-channel.js'
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

/** The enrolled host's loop (C5.1): the capacity report every 30 s; a failed report is logged by its message. */
export class HostAgentLoop
{
    public static readonly IntervalMs = 30_000
    private static readonly ReportFailed = 'capacity report failed'
    private static readonly ErrorKey = 'error'
    private static readonly Unknown = 'unknown error'
    private readonly reportTask: RepeatingTask

    public constructor(
        private readonly channel: HostChannel,
        private readonly reporter: CapacityReporter,
        private readonly logger: ILogger,
        intervalMs: number = HostAgentLoop.IntervalMs)
    {
        this.reportTask = new RepeatingTask(intervalMs, () => this.ReportOnce())
    }

    public Start(): void
    {
        this.reportTask.Start()
    }

    public Stop(): void
    {
        this.reportTask.Stop()
    }

    public async ReportOnce(): Promise<void>
    {
        await this.Guard(HostAgentLoop.ReportFailed, async () => this.channel.Notify(MessageKind.HostReport, await this.reporter.Report()))
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
