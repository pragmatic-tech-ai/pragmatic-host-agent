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

/** Whether a process id is alive on this machine (process.kill(pid, 0); faked in tests). */
export interface IProcessTable
{
    readonly OwnPid: number
    IsAlive(pid: number): boolean
}

export class NodeProcessTable implements IProcessTable
{
    private static readonly NoSuchProcess = 'ESRCH'

    public get OwnPid(): number
    {
        return process.pid
    }

    public IsAlive(pid: number): boolean
    {
        try
        {
            process.kill(pid, 0)
            return true
        }
        catch (error)
        {
            return (error as NodeJS.ErrnoException).code !== NodeProcessTable.NoSuchProcess
        }
    }
}

/**
 * One host agent per state directory: `<state dir>/agent.lock` names its holder (a random instance id, its pid, a
 * heartbeat). It is created exclusively (O_EXCL); a lock already there is taken over only when it is stale: its
 * heartbeat is older than `StaleMs`, or its pid is not alive and not this process's own (a container restarted with the
 * same pid 1 waits out the heartbeat instead, since in another container pid 1 is alive). The holder refreshes the
 * heartbeat every report pass (`Refresh`).
 */
export class StateLock
{
    public static readonly FileName = 'agent.lock'
    public static readonly StaleMs = 90_000
    private static readonly IdBytes = 12
    private static readonly Hex = 'hex'
    private readonly instance = randomBytes(StateLock.IdBytes).toString(StateLock.Hex)

    public constructor(private readonly files: StateFiles, private readonly now: () => Date = () => new Date(), private readonly processes: IProcessTable = new NodeProcessTable())
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
        if (this.now().getTime() - held.heartbeat > StateLock.StaleMs)
        {
            return true
        }
        return held.pid !== this.processes.OwnPid && !this.processes.IsAlive(held.pid)
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
        return JSON.stringify({ instance: this.instance, pid: this.processes.OwnPid, heartbeat: this.now().toISOString() })
    }
}
