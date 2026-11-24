import { readdir } from 'node:fs/promises'
import { ProtocolNames } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { StateFiles } from '../state/state-files.js'
import { PlacementRecord } from './placement-record.js'

/** A placement file is there but does not read as a placement (edited by hand?). */
export class PlacementRecordUnreadableError extends Error
{
    private static readonly ErrorName = 'PlacementRecordUnreadableError'
    private static readonly Prefix = 'the placement file does not read as a placement: '

    public constructor(file: string)
    {
        super(PlacementRecordUnreadableError.Prefix + file)
        this.name = PlacementRecordUnreadableError.ErrorName
    }
}

/**
 * The machine's placements (`<state dir>/placements/<id>.json`, one file each, written whole), the pull cursor
 * (`<state dir>/placement-cursor.json`) and the tombstones of finished placements (`<state dir>/placement-tombstones.json`:
 * id -> the last version, so a finished placement's file can go while a late request for it is still recognised). What
 * was pulled survives a restart, and every step a placement finished is recorded before the next one starts. One
 * unreadable placement file never breaks the others: `All` skips it (logged) and `Unreadable` names it.
 */
export class PlacementStore
{
    public static readonly Directory = 'placements'
    public static readonly CursorFile = 'placement-cursor.json'
    public static readonly TombstonesFile = 'placement-tombstones.json'
    private static readonly JsonSuffix = '.json'
    private static readonly CursorKey = 'after'
    private static readonly UnreadableLine = 'placement file unreadable: skipped'
    private static readonly FileKey = 'file'
    private readonly unreadable = new Set<string>()

    public constructor(private readonly files: StateFiles, private readonly logger: ILogger = new NullLogger())
    {
    }

    public async Get(placementId: string): Promise<PlacementRecord | undefined>
    {
        if (!ProtocolNames.Label.test(placementId))
        {
            return undefined
        }
        const path = this.PathOf(placementId)
        let raw: unknown
        try
        {
            raw = await this.files.ReadJson(path)
        }
        catch
        {
            throw new PlacementRecordUnreadableError(placementId + PlacementStore.JsonSuffix)
        }
        if (raw === undefined)
        {
            return undefined
        }
        const record = PlacementRecord.Parse(raw)
        if (record === undefined || record.Id !== placementId)
        {
            throw new PlacementRecordUnreadableError(placementId + PlacementStore.JsonSuffix)
        }
        return record
    }

    public async Put(record: PlacementRecord): Promise<void>
    {
        await this.files.WriteJson(this.PathOf(record.Id), record.Json)
        this.unreadable.delete(record.Id)
    }

    /** Every readable placement on record, ordered by id; an unreadable file is skipped and logged. */
    public async All(): Promise<PlacementRecord[]>
    {
        const S = PlacementStore
        let names: string[]
        try
        {
            names = await readdir(this.files.Path(S.Directory))
        }
        catch (error)
        {
            if (StateFiles.IsNotFound(error))
            {
                return []
            }
            throw error
        }
        const records: PlacementRecord[] = []
        for (const name of names.filter(entry => entry.endsWith(S.JsonSuffix)).sort())
        {
            const id = name.slice(0, -S.JsonSuffix.length)
            try
            {
                const record = await this.Get(id)
                if (record !== undefined)
                {
                    records.push(record)
                    this.unreadable.delete(id)
                }
            }
            catch (error)
            {
                if (!(error instanceof PlacementRecordUnreadableError))
                {
                    throw error
                }
                if (!this.unreadable.has(id))
                {
                    this.logger.Error(S.UnreadableLine, { [S.FileKey]: name })
                }
                this.unreadable.add(id)
            }
        }
        return records
    }

    /** The placement ids whose files did not read at the last `All` (reported failed: what they hold is unknown). */
    public get Unreadable(): readonly string[]
    {
        return [...this.unreadable].filter(id => ProtocolNames.Label.test(id)).sort()
    }

    /** Drops a finished placement's file, keeping its tombstone (id and last version). */
    public async Prune(record: PlacementRecord): Promise<void>
    {
        const tombstones = await this.Tombstones()
        tombstones[record.Id] = Math.max(tombstones[record.Id] ?? 0, record.Json.Version)
        await this.files.WriteJson(this.files.Path(PlacementStore.TombstonesFile), tombstones)
        await this.files.Remove(this.PathOf(record.Id))
    }

    /** The last version of a pruned placement, or undefined when it was never pruned. */
    public async TombstoneOf(placementId: string): Promise<number | undefined>
    {
        return (await this.Tombstones())[placementId]
    }

    public async Cursor(): Promise<number>
    {
        const raw = await this.files.ReadJson(this.files.Path(PlacementStore.CursorFile)) as Record<string, unknown> | undefined
        const after = raw?.[PlacementStore.CursorKey]
        return typeof after === 'number' && Number.isSafeInteger(after) && after >= 0 ? after : 0
    }

    public async SetCursor(after: number): Promise<void>
    {
        await this.files.WriteJson(this.files.Path(PlacementStore.CursorFile), { [PlacementStore.CursorKey]: after })
    }

    private async Tombstones(): Promise<Record<string, number>>
    {
        const raw = await this.files.ReadJson(this.files.Path(PlacementStore.TombstonesFile))
        const result: Record<string, number> = {}
        if (typeof raw === 'object' && raw !== null)
        {
            for (const [id, version] of Object.entries(raw as Record<string, unknown>))
            {
                if (ProtocolNames.Label.test(id) && typeof version === 'number' && Number.isSafeInteger(version))
                {
                    result[id] = version
                }
            }
        }
        return result
    }

    private PathOf(placementId: string): string
    {
        return this.files.Path(PlacementStore.Directory, placementId + PlacementStore.JsonSuffix)
    }
}
