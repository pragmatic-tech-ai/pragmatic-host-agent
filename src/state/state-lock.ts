import { randomBytes } from 'node:crypto'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { IDelay } from '../process/delay.js'
import type { StateFiles } from './state-files.js'

/** Another host agent holds the state directory: two agents on one directory would place every hive twice. */
export class StateLockHeldError extends Error
{
    private static readonly ErrorName = 'StateLockHeldError'
    private static readonly Text = 'another host agent holds the state directory (agent.lock); this one does not start'

    public constructor()
    {
        super(StateLockHeldError.Text)
        this.name = StateLockHeldError.ErrorName
    }
}

/**
 * One host agent per state directory: `<state dir>/agent.lock` names its holder (a random instance id, its pid, a
 * heartbeat). It is created exclusively (O_EXCL); a lock already there is taken over only when it is stale: its
 * heartbeat is older than `StaleMs` (or it does not read). The pid is recorded for an operator only, never trusted: across
 * pid namespaces (containers) a pid says nothing about the holder. The holder refreshes the heartbeat every report pass
 * (`Refresh`). A graceful stop releases it (`Release`: only while it is still this instance's); a start that finds a live
 * lock waits inside the process until it goes stale (`AcquireWhenFree`), so a crash restart never depends on docker's
 * restart backoff.
 */
export class StateLock
{
    public static readonly FileName = 'agent.lock'
    public static readonly StaleMs = 90_000
    private static readonly IdBytes = 12
    private static readonly Hex = 'hex'
    public static readonly RetryMs = 10_000
    private static readonly WaitingLine = 'another host agent holds the state directory: waiting until its lock goes stale'
    private static readonly EventKey = 'event'
    private static readonly WaitingEvent = 'lock-wait'
    private readonly instance = randomBytes(StateLock.IdBytes).toString(StateLock.Hex)
    private released = false

    public constructor(private readonly files: StateFiles, private readonly now: () => Date = () => new Date())
    {
    }

    public async Acquire(): Promise<void>
    {
        const path = this.files.Path(StateLock.FileName)
        if (await this.files.CreateExclusive(path, this.Text()))
        {
            return
        }
        if (!this.Stale(await this.files.ReadText(path)))
        {
            throw new StateLockHeldError()
        }
        // Stale: replace it, then make sure this instance won (another taking it over at once wins otherwise).
        await this.files.Remove(path)
        if (!await this.files.CreateExclusive(path, this.Text()))
        {
            throw new StateLockHeldError()
        }
    }

    /** Acquire, waiting (logged once) while another agent's lock is fresh: a crashed holder's lock goes stale in StaleMs. */
    public async AcquireWhenFree(delay: IDelay, logger: ILogger): Promise<void>
    {
        let logged = false
        for (;;)
        {
            try
            {
                await this.Acquire()
                return
            }
            catch (error)
            {
                if (!(error instanceof StateLockHeldError))
                {
                    throw error
                }
                if (!logged)
                {
                    logger.Warn(StateLock.WaitingLine, { [StateLock.EventKey]: StateLock.WaitingEvent })
                    logged = true
                }
                await delay.Wait(StateLock.RetryMs)
            }
        }
    }

    /** Deletes the lock file while it is still this instance's; one taken over by another agent is left alone. */
    public async Release(): Promise<boolean>
    {
        // From here on no heartbeat writes the lock back.
        this.released = true
        const path = this.files.Path(StateLock.FileName)
        const held = this.Parse(await this.files.ReadText(path))
        if (held === undefined || held.instance !== this.instance)
        {
            return false
        }
        await this.files.Remove(path)
        return true
    }

    /** The heartbeat; throws StateLockHeldError when another agent took the directory over meanwhile. */
    public async Refresh(): Promise<void>
    {
        if (this.released)
        {
            return
        }
        const path = this.files.Path(StateLock.FileName)
        const held = this.Parse(await this.files.ReadText(path))
        if (held !== undefined && held.instance !== this.instance)
        {
            throw new StateLockHeldError()
        }
        await this.files.WriteText(path, this.Text())
    }

    private Stale(text: string | undefined): boolean
    {
        const held = this.Parse(text)
        if (held === undefined)
        {
            return true
        }
        return this.now().getTime() - held.heartbeat > StateLock.StaleMs
    }

    private Parse(text: string | undefined): { instance: string; pid: number; heartbeat: number } | undefined
    {
        if (text === undefined)
        {
            return undefined
        }
        try
        {
            const raw = JSON.parse(text) as { instance?: unknown; pid?: unknown; heartbeat?: unknown }
            const heartbeat = typeof raw.heartbeat === 'string' ? Date.parse(raw.heartbeat) : NaN
            if (typeof raw.instance !== 'string' || typeof raw.pid !== 'number' || Number.isNaN(heartbeat))
            {
                return undefined
            }
            return { instance: raw.instance, pid: raw.pid, heartbeat }
        }
        catch
        {
            return undefined
        }
    }

    private Text(): string
    {
        return JSON.stringify({ instance: this.instance, pid: process.pid, heartbeat: this.now().toISOString() })
    }
}
