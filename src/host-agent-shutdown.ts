import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { StateLock } from './state/state-lock.js'

/** Something the shutdown stops first (the loops, the heartbeat). */
export interface IStoppable
{
    Stop(): void
}

/** The process the shutdown listens on and exits (faked in tests). */
export interface IShutdownProcess
{
    On(signal: string, handler: () => void): void
    Exit(code: number): void
}

export class NodeShutdownProcess implements IShutdownProcess
{
    public On(signal: string, handler: () => void): void
    {
        process.once(signal as NodeJS.Signals, handler)
    }

    public Exit(code: number): void
    {
        process.exit(code)
    }
}

/**
 * A graceful stop (SIGTERM from `docker stop`/`docker restart`, SIGINT): the loops and the heartbeat stop, the state
 * directory lock is released while it is still ours (a lock another agent took over is left alone), and the process exits
 * 0. A placement step still running is cut off by the exit: every step's record is resumable, so the next start picks it
 * up. A crash releases nothing; the next start waits for the lock's heartbeat to go stale.
 */
export class HostAgentShutdown
{
    public static readonly Signals: readonly string[] = ['SIGTERM', 'SIGINT']
    private static readonly StoppingLine = 'pragmatic-host-agentd stopping'
    private static readonly EventKey = 'event'
    private static readonly StoppingEvent = 'shutdown'
    private static readonly ReleasedKey = 'lockReleased'
    private readonly stoppables: IStoppable[] = []
    private stopping = false
    private done: Promise<void> | undefined

    public constructor(private readonly lock: StateLock, private readonly logger: ILogger, private readonly host: IShutdownProcess = new NodeShutdownProcess())
    {
    }

    public Install(): this
    {
        for (const signal of HostAgentShutdown.Signals)
        {
            this.host.On(signal, () => void this.Stop())
        }
        return this
    }

    public Add(stoppable: IStoppable): void
    {
        this.stoppables.push(stoppable)
    }

    /** The lock was taken over: stop everything without touching the lock (it is another agent's now) and exit 1. */
    public Abandon(): void
    {
        if (this.stopping)
        {
            return
        }
        this.stopping = true
        for (const stoppable of this.stoppables)
        {
            stoppable.Stop()
        }
        this.host.Exit(1)
    }

    /** Stops once; a second call (a second signal) answers the first stop. */
    public Stop(): Promise<void>
    {
        if (this.done === undefined)
        {
            this.done = this.StopOnce()
        }
        return this.done
    }

    private async StopOnce(): Promise<void>
    {
        const H = HostAgentShutdown
        if (this.stopping)
        {
            return
        }
        this.stopping = true
        for (const stoppable of this.stoppables)
        {
            stoppable.Stop()
        }
        let released = false
        try
        {
            released = await this.lock.Release()
        }
        finally
        {
            this.logger.Info(H.StoppingLine, { [H.EventKey]: H.StoppingEvent, [H.ReleasedKey]: released })
            this.host.Exit(0)
        }
    }
}
