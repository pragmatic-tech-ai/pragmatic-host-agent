import { randomBytes } from 'node:crypto'
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
 * (`Refresh`).
 */
export class StateLock
{
    public static readonly FileName = 'agent.lock'
    public static readonly StaleMs = 90_000
    private static readonly IdBytes = 12
    private static readonly Hex = 'hex'
    private readonly instance = randomBytes(StateLock.IdBytes).toString(StateLock.Hex)

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

    /** The heartbeat; throws StateLockHeldError when another agent took the directory over meanwhile. */
    public async Refresh(): Promise<void>
    {
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
