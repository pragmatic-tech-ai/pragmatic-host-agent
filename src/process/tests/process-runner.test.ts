import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CheckedRunner, NodeProcessRunner, ProcessCommand, ProcessFailedError } from '../process-runner.js'

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
})
