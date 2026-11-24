import { spawn } from 'node:child_process'

/**
 * One program run: the program and its argument vector, never a shell string (no shell ever parses it), and the bytes
 * written to its standard input (where a secret goes, never on the argument vector).
 */
export class ProcessCommand
{
    public constructor(
        public readonly Program: string,
        public readonly Args: readonly string[],
        public readonly Stdin: Buffer | undefined = undefined)
    {
    }

    /** `program args...` for a log line or an error: the argument vector only (secrets never travel there). */
    public Describe(): string
    {
        return [this.Program, ...this.Args].join(ProcessCommand.Space)
    }

    private static readonly Space = ' '
}

/** How a run ended: its exit code and what it wrote. */
export class ProcessResult
{
    public constructor(public readonly ExitCode: number, public readonly Stdout: string, public readonly Stderr: string)
    {
    }

    public get Succeeded(): boolean
    {
        return this.ExitCode === 0
    }
}

/** A run that did not exit 0: the program, its exit code and the last line it wrote to stderr (bounded). */
export class ProcessFailedError extends Error
{
    private static readonly ErrorName = 'ProcessFailedError'
    private static readonly ExitedText = ' exited '
    private static readonly Separator = ': '
    private static readonly MaxDetail = 300

    public constructor(public readonly Program: string, public readonly ExitCode: number, stderr: string)
    {
        super(Program + ProcessFailedError.ExitedText + ExitCode + ProcessFailedError.Detail(stderr))
        this.name = ProcessFailedError.ErrorName
    }

    private static Detail(stderr: string): string
    {
        const lines = stderr.trim().split(/\r?\n/).filter(line => line.length > 0)
        const last = lines.length === 0 ? '' : lines[lines.length - 1]
        return last.length === 0 ? '' : ProcessFailedError.Separator + last.slice(0, ProcessFailedError.MaxDetail)
    }
}

/** Runs programs by argument vector (kind, helm, kubectl, docker). Implementations never go through a shell. */
export interface IProcessRunner
{
    Run(command: ProcessCommand): Promise<ProcessResult>
}

/** IProcessRunner over `child_process.spawn` with `shell: false`; output is kept up to 16 MiB per stream. */
export class NodeProcessRunner implements IProcessRunner
{
    private static readonly MaxOutput = 16 * 1024 * 1024
    private static readonly Utf8 = 'utf8'
    private static readonly SpawnFailedCode = 127

    public Run(command: ProcessCommand): Promise<ProcessResult>
    {
        const N = NodeProcessRunner
        return new Promise(resolve =>
        {
            const child = spawn(command.Program, [...command.Args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
            const stdout: Buffer[] = []
            const stderr: Buffer[] = []
            let outSize = 0
            let errSize = 0
            child.stdout.on('data', (chunk: Buffer) =>
            {
                outSize += chunk.length
                if (outSize <= N.MaxOutput) stdout.push(chunk)
            })
            child.stderr.on('data', (chunk: Buffer) =>
            {
                errSize += chunk.length
                if (errSize <= N.MaxOutput) stderr.push(chunk)
            })
            child.on('error', error => resolve(new ProcessResult(N.SpawnFailedCode, '', error.message)))
            child.on('close', code => resolve(new ProcessResult(code ?? 1, Buffer.concat(stdout).toString(N.Utf8), Buffer.concat(stderr).toString(N.Utf8))))
            child.stdin.on('error', () => undefined)
            child.stdin.end(command.Stdin ?? Buffer.alloc(0))
        })
    }
}

/** Runs and throws ProcessFailedError unless the program exited 0. */
export class CheckedRunner
{
    public constructor(private readonly runner: IProcessRunner)
    {
    }

    public get Runner(): IProcessRunner
    {
        return this.runner
    }

    public async Run(command: ProcessCommand): Promise<ProcessResult>
    {
        const result = await this.runner.Run(command)
        if (!result.Succeeded)
        {
            throw new ProcessFailedError(command.Program, result.ExitCode, result.Stderr)
        }
        return result
    }
}
