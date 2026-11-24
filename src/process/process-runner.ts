import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * One program run: the program and its argument vector, never a shell string (no shell ever parses it), the bytes
 * written to its standard input (where a secret goes, never on the argument vector) and how long it may run.
 */
export class ProcessCommand
{
    private static readonly Space = ' '

    public constructor(
        public readonly Program: string,
        public readonly Args: readonly string[],
        public readonly Stdin: Buffer | undefined = undefined,
        /** Killed after this long (undefined: the runner's default). */
        public readonly TimeoutMs: number | undefined = undefined)
    {
    }

    /** `program args...` for a log line or an error: the argument vector only (secrets never travel there). */
    public Describe(): string
    {
        return [this.Program, ...this.Args].join(ProcessCommand.Space)
    }
}

/** How a run ended: its exit code and what it wrote; `TimedOut` when it was killed at its deadline. */
export class ProcessResult
{
    public constructor(public readonly ExitCode: number, public readonly Stdout: string, public readonly Stderr: string, public readonly TimedOut: boolean = false)
    {
    }

    public get Succeeded(): boolean
    {
        return this.ExitCode === 0 && !this.TimedOut
    }
}

/** A run that did not exit 0: the program, its exit code and the last line it wrote to stderr (bounded). */
export class ProcessFailedError extends Error
{
    private static readonly ErrorName = 'ProcessFailedError'
    private static readonly ExitedText = ' exited '
    private static readonly TimedOutText = ' was killed at its deadline'
    private static readonly Separator = ': '
    private static readonly MaxDetail = 300
    private static readonly LineBreak = /\r?\n/

    public constructor(public readonly Program: string, public readonly ExitCode: number, stderr: string, public readonly TimedOut: boolean = false)
    {
        super(Program + (TimedOut ? ProcessFailedError.TimedOutText : ProcessFailedError.ExitedText + ExitCode) + ProcessFailedError.Detail(stderr))
        this.name = ProcessFailedError.ErrorName
    }

    private static Detail(stderr: string): string
    {
        const lines = stderr.trim().split(ProcessFailedError.LineBreak).filter(line => line.length > 0)
        const last = lines.length === 0 ? '' : lines[lines.length - 1]
        return last.length === 0 ? '' : ProcessFailedError.Separator + last.slice(0, ProcessFailedError.MaxDetail)
    }
}

/** Runs programs by argument vector (kind, helm, kubectl, docker). Implementations never go through a shell. */
export interface IProcessRunner
{
    Run(command: ProcessCommand): Promise<ProcessResult>
}

/** Starts a child process (child_process.spawn; faked in tests). */
export interface ISpawner
{
    Spawn(program: string, args: readonly string[]): ChildProcessWithoutNullStreams
}

/** ISpawner over `child_process.spawn` with `shell: false`. */
export class NodeSpawner implements ISpawner
{
    private static readonly Pipe = 'pipe'

    public Spawn(program: string, args: readonly string[]): ChildProcessWithoutNullStreams
    {
        return spawn(program, [...args], { shell: false, stdio: [NodeSpawner.Pipe, NodeSpawner.Pipe, NodeSpawner.Pipe], windowsHide: true })
    }
}

/**
 * IProcessRunner over a spawner; output is kept up to 16 MiB per stream. Every run has a deadline (the command's, else
 * `DefaultTimeoutMs`): a child still running then is killed (SIGKILL) and the run answers `TimedOut`, so no hung
 * kind, helm or kubectl holds a placement step forever.
 */
export class NodeProcessRunner implements IProcessRunner
{
    public static readonly DefaultTimeoutMs = 10 * 60 * 1000
    private static readonly MaxOutput = 16 * 1024 * 1024
    private static readonly Utf8 = 'utf8'
    private static readonly SpawnFailedCode = 127
    private static readonly KilledCode = 137
    private static readonly Kill = 'SIGKILL'
    private static readonly Data = 'data'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'

    public constructor(private readonly spawner: ISpawner = new NodeSpawner(), private readonly defaultTimeoutMs: number = NodeProcessRunner.DefaultTimeoutMs)
    {
    }

    public Run(command: ProcessCommand): Promise<ProcessResult>
    {
        const N = NodeProcessRunner
        return new Promise(resolve =>
        {
            const child = this.spawner.Spawn(command.Program, command.Args)
            const stdout: Buffer[] = []
            const stderr: Buffer[] = []
            let outSize = 0
            let errSize = 0
            let timedOut = false
            let settled = false
            const finish = (result: ProcessResult): void =>
            {
                if (!settled)
                {
                    settled = true
                    clearTimeout(timer)
                    resolve(result)
                }
            }
            const timer = setTimeout(() =>
            {
                timedOut = true
                child.kill(N.Kill)
                finish(new ProcessResult(N.KilledCode, Buffer.concat(stdout).toString(N.Utf8), Buffer.concat(stderr).toString(N.Utf8), true))
            }, command.TimeoutMs ?? this.defaultTimeoutMs)
            child.stdout.on(N.Data, (chunk: Buffer) =>
            {
                outSize += chunk.length
                if (outSize <= N.MaxOutput) stdout.push(chunk)
            })
            child.stderr.on(N.Data, (chunk: Buffer) =>
            {
                errSize += chunk.length
                if (errSize <= N.MaxOutput) stderr.push(chunk)
            })
            child.on(N.ErrorEvent, error => finish(new ProcessResult(N.SpawnFailedCode, '', error.message)))
            child.on(N.CloseEvent, code => finish(new ProcessResult(code ?? 1, Buffer.concat(stdout).toString(N.Utf8), Buffer.concat(stderr).toString(N.Utf8), timedOut)))
            child.stdin.on(N.ErrorEvent, () => undefined)
            child.stdin.end(command.Stdin ?? Buffer.alloc(0))
        })
    }
}

/** Runs and throws ProcessFailedError unless the program exited 0 within its deadline. */
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
            throw new ProcessFailedError(command.Program, result.ExitCode, result.Stderr, result.TimedOut)
        }
        return result
    }
}
