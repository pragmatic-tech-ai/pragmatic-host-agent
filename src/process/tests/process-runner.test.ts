import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, it } from 'node:test'
import { CheckedRunner, NodeProcessRunner, ProcessCommand, ProcessFailedError, type ISpawner } from '../process-runner.js'

/** A child that never exits by itself: it closes only when killed, and records the signal. */
class HangingChild extends EventEmitter
{
    public readonly stdout = new PassThrough()
    public readonly stderr = new PassThrough()
    public readonly stdin = new Writable({ write: (_chunk, _encoding, done) => done() })
    public Signals: string[] = []

    public kill(signal: string): boolean
    {
        this.Signals.push(signal)
        setImmediate(() => this.emit('close', null))
        return true
    }
}

class HangingSpawner implements ISpawner
{
    public readonly Children: HangingChild[] = []

    public Spawn(): ChildProcessWithoutNullStreams
    {
        const child = new HangingChild()
        this.Children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
    }
}

describe('NodeProcessRunner', () =>
{
    it('passes the argument vector as it is (no shell parses it) and writes standard input', async () =>
    {
        const script = 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.stringify([process.argv.slice(1),s])))'
        const args = ['-e', script, '$(echo pwned)', 'a b; rm -rf /', '"quoted"', '*']
        const result = await new NodeProcessRunner().Run(new ProcessCommand(process.execPath, args, Buffer.from('secret on stdin')))
        assert.equal(result.ExitCode, 0, result.Stderr)
        assert.deepEqual(JSON.parse(result.Stdout), [['$(echo pwned)', 'a b; rm -rf /', '"quoted"', '*'], 'secret on stdin'])
    })

    it('a non-zero exit is a ProcessFailedError naming the program and the last stderr line, never the arguments', async () =>
    {
        const runner = new CheckedRunner(new NodeProcessRunner())
        await assert.rejects(runner.Run(new ProcessCommand(process.execPath, ['-e', 'console.error("first\\nlast line");process.exit(3)', 'argument-value'])),
            (error: unknown) => error instanceof ProcessFailedError && error.ExitCode === 3 && error.message.endsWith('exited 3: last line') && !error.message.includes('argument-value'))
        const missing = await new NodeProcessRunner().Run(new ProcessCommand('pragmatic-no-such-program', []))
        assert.notEqual(missing.ExitCode, 0)
    })

    it('kills a child still running at its deadline and fails the run as timed out', async () =>
    {
        const spawner = new HangingSpawner()
        const runner = new NodeProcessRunner(spawner, 60_000)
        const result = await runner.Run(new ProcessCommand('helm', ['upgrade'], undefined, 20))
        assert.equal(result.TimedOut, true)
        assert.equal(result.Succeeded, false)
        assert.deepEqual(spawner.Children[0].Signals, ['SIGKILL'])
        await assert.rejects(new CheckedRunner(new NodeProcessRunner(new HangingSpawner(), 20)).Run(new ProcessCommand('kind', ['create', 'cluster'])),
            (error: unknown) => error instanceof ProcessFailedError && error.TimedOut && error.message.startsWith('kind was killed at its deadline'))
    })
})
