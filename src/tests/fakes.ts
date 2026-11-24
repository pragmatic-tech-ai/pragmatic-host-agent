import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessResult, type IProcessRunner, type ProcessCommand } from '../process/process-runner.js'
import { StateFiles } from '../state/state-files.js'

/** A scripted answer of the fake runner: the first rule whose predicate matches answers the command. */
export class FakeRule
{
    public constructor(public readonly Matches: (command: ProcessCommand) => boolean, public readonly Answer: (command: ProcessCommand) => ProcessResult)
    {
    }
}

/** IProcessRunner that records every argument vector (and standard input) and answers by rule; unmatched commands exit 0. */
export class FakeProcessRunner implements IProcessRunner
{
    public readonly Commands: ProcessCommand[] = []
    private readonly rules: FakeRule[] = []

    public On(matches: (command: ProcessCommand) => boolean, answer: (command: ProcessCommand) => ProcessResult): this
    {
        this.rules.push(new FakeRule(matches, answer))
        return this
    }

    /** Answers commands whose argv starts with `prefix` (program first). */
    public OnPrefix(prefix: readonly string[], answer: (command: ProcessCommand) => ProcessResult): this
    {
        return this.On(command => FakeProcessRunner.StartsWith(command, prefix), answer)
    }

    public Run(command: ProcessCommand): Promise<ProcessResult>
    {
        this.Commands.push(command)
        const rule = this.rules.find(candidate => candidate.Matches(command))
        return Promise.resolve(rule === undefined ? new ProcessResult(0, '', '') : rule.Answer(command))
    }

    /** Every recorded argument vector, the program first. */
    public get Argvs(): string[][]
    {
        return this.Commands.map(command => [command.Program, ...command.Args])
    }

    public static StartsWith(command: ProcessCommand, prefix: readonly string[]): boolean
    {
        const argv = [command.Program, ...command.Args]
        return prefix.every((part, index) => argv[index] === part)
    }

    public static Ok(stdout: string = ''): ProcessResult
    {
        return new ProcessResult(0, stdout, '')
    }

    public static Fail(stderr: string, code: number = 1): ProcessResult
    {
        return new ProcessResult(code, '', stderr)
    }
}

/** A fresh state directory under the system temp directory, removed by `Dispose`. */
export class TempState
{
    private static readonly Prefix = 'pragmatic-host-agent-test-'
    public readonly Dir: string
    public readonly Files: StateFiles

    public constructor()
    {
        this.Dir = mkdtempSync(join(tmpdir(), TempState.Prefix))
        this.Files = new StateFiles(this.Dir)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}
