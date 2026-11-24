import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The host agent's files under its state directory: JSON written whole (a temporary file beside it, then renamed, so a
 * crash mid-write leaves the old file or the new one, never half of either), read back strictly, private to the
 * agent's user (0600 files, 0700 directories).
 */
export class StateFiles
{
    public static readonly FileMode = 0o600
    public static readonly DirMode = 0o700
    private static readonly Utf8 = 'utf8'
    private static readonly TempSuffix = '.tmp-'
    private static readonly TempBytes = 6
    private static readonly Hex = 'hex'
    private static readonly NotFound = 'ENOENT'
    private static readonly Exists = 'EEXIST'
    private static readonly ExclusiveFlag = 'wx'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'

    public constructor(public readonly Root: string)
    {
    }

    public Path(...segments: string[]): string
    {
        return join(this.Root, ...segments)
    }

    public async EnsureDir(...segments: string[]): Promise<string>
    {
        const path = this.Path(...segments)
        await mkdir(path, { recursive: true, mode: StateFiles.DirMode })
        return path
    }

    /** The file's text, or undefined when it does not exist. */
    public async ReadText(path: string): Promise<string | undefined>
    {
        try
        {
            return await readFile(path, StateFiles.Utf8)
        }
        catch (error)
        {
            if (StateFiles.IsNotFound(error))
            {
                return undefined
            }
            throw error
        }
    }

    public async ReadJson(path: string): Promise<unknown>
    {
        const text = await this.ReadText(path)
        return text === undefined ? undefined : JSON.parse(text) as unknown
    }

    /** Writes the file whole (temporary file, then rename), mode 0600. */
    public async WriteText(path: string, text: string): Promise<void>
    {
        const S = StateFiles
        await mkdir(dirname(path), { recursive: true, mode: S.DirMode })
        const temp = path + S.TempSuffix + randomBytes(S.TempBytes).toString(S.Hex)
        await writeFile(temp, text, { encoding: S.Utf8, mode: S.FileMode })
        await rename(temp, path)
    }

    public WriteJson(path: string, value: unknown): Promise<void>
    {
        return this.WriteText(path, JSON.stringify(value, null, StateFiles.JsonIndent) + StateFiles.Newline)
    }

    /** Creates the file only when it does not exist yet (mode 0600); false when it already did. */
    public async CreateExclusive(path: string, text: string): Promise<boolean>
    {
        await mkdir(dirname(path), { recursive: true, mode: StateFiles.DirMode })
        try
        {
            await writeFile(path, text, { encoding: StateFiles.Utf8, mode: StateFiles.FileMode, flag: StateFiles.ExclusiveFlag })
            return true
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code === StateFiles.Exists)
            {
                return false
            }
            throw error
        }
    }

    public async Remove(path: string): Promise<void>
    {
        await rm(path, { recursive: true, force: true })
    }

    public static IsNotFound(error: unknown): boolean
    {
        return (error as NodeJS.ErrnoException | undefined)?.code === StateFiles.NotFound
    }
}
