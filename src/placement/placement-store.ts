import { readdir } from 'node:fs/promises'
import { ProtocolNames } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
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
 * The machine's placements (`<state dir>/placements/<id>.json`, one file each, written whole) and the pull cursor
 * (`<state dir>/placement-cursor.json`): what was pulled survives a restart, and every step a placement finished is
 * recorded before the next one starts.
 */
export class PlacementStore
{
    public static readonly Directory = 'placements'
    public static readonly CursorFile = 'placement-cursor.json'
    private static readonly JsonSuffix = '.json'
    private static readonly CursorKey = 'after'

    public constructor(private readonly files: StateFiles)
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
    }

    /** Every placement on record, ordered by id. */
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
            const record = await this.Get(name.slice(0, -S.JsonSuffix.length))
            if (record !== undefined)
            {
                records.push(record)
            }
        }
        return records
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

    private PathOf(placementId: string): string
    {
        return this.files.Path(PlacementStore.Directory, placementId + PlacementStore.JsonSuffix)
    }
}
