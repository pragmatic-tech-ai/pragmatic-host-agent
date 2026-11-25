import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { NullLogger, StructuredLogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { HostAgentShutdown, type IShutdownProcess, type IStoppable } from '../host-agent-shutdown.js'
import type { IDelay } from '../process/delay.js'
import { StateLock, StateLockHeldError } from '../state/state-lock.js'
import { TempState } from './fakes.js'

class FakeProcess implements IShutdownProcess
{
    public readonly Handlers = new Map<string, () => void>()
    public readonly Exits: number[] = []

    public On(signal: string, handler: () => void): void
    {
        this.Handlers.set(signal, handler)
    }

    public Exit(code: number): void
    {
        this.Exits.push(code)
    }
}

class Stopped implements IStoppable
{
    public Stops = 0

    public Stop(): void
    {
        this.Stops += 1
    }
}

class ShutdownFixture
{
    public Now = new Date('2026-11-25T12:00:00.000Z')
    public readonly Clock = (): Date => this.Now
}

/** A delay that moves the fixture's clock instead of waiting. */
class ClockDelay implements IDelay
{
    public Waits = 0

    public constructor(private readonly fixture: ShutdownFixture)
    {
    }

    public Wait(ms: number): Promise<void>
    {
        this.Waits += 1
        this.fixture.Now = new Date(this.fixture.Now.getTime() + ms)
        return Promise.resolve()
    }
}

describe('HostAgentShutdown', () =>
{
    const states: TempState[] = []
    after(() => states.forEach(state => state.Dispose()))
    const fresh = (): TempState =>
    {
        const state = new TempState()
        states.push(state)
        return state
    }

    it('a stopped agent (SIGTERM) stops its loops, releases its lock and exits 0; a new one starts at once', async () =>
    {
        const state = fresh()
        const f = new ShutdownFixture()
        const lock = new StateLock(state.Files, f.Clock)
        await lock.Acquire()
        const host = new FakeProcess()
        const shutdown = new HostAgentShutdown(lock, new NullLogger(), host).Install()
        const loop = new Stopped()
        shutdown.Add(loop)
        assert.deepEqual([...host.Handlers.keys()], ['SIGTERM', 'SIGINT'])
        host.Handlers.get('SIGTERM')?.()
        await shutdown.Stop()
        assert.equal(loop.Stops, 1)
        assert.deepEqual(host.Exits, [0])
        assert.equal(await state.Files.ReadText(state.Files.Path(StateLock.FileName)), undefined)
        // No heartbeat writes it back after the release.
        await lock.Refresh()
        assert.equal(await state.Files.ReadText(state.Files.Path(StateLock.FileName)), undefined)
        // The restarted agent: no wait, the same instant.
        const delay = new ClockDelay(f)
        await new StateLock(state.Files, f.Clock).AcquireWhenFree(delay, new NullLogger())
        assert.equal(delay.Waits, 0)
    })

    it('a lock taken over by another instance is not deleted by the old one', async () =>
    {
        const state = fresh()
        const f = new ShutdownFixture()
        const old = new StateLock(state.Files, f.Clock)
        await old.Acquire()
        f.Now = new Date(f.Now.getTime() + StateLock.StaleMs + 1)
        const current = new StateLock(state.Files, f.Clock)
        await current.Acquire()
        const host = new FakeProcess()
        await new HostAgentShutdown(old, new NullLogger(), host).Stop()
        assert.deepEqual(host.Exits, [0])
        assert.ok(await state.Files.ReadText(state.Files.Path(StateLock.FileName)) !== undefined)
        await current.Refresh()
        await assert.rejects(new StateLock(state.Files, f.Clock).Acquire(), StateLockHeldError)
    })

    it('a start after a crash waits inside the process until the left lock goes stale, logging once', async () =>
    {
        const state = fresh()
        const f = new ShutdownFixture()
        // The crashed agent: its lock stays, never refreshed again.
        await new StateLock(state.Files, f.Clock).Acquire()
        const lines: string[] = []
        const delay = new ClockDelay(f)
        await new StateLock(state.Files, f.Clock).AcquireWhenFree(delay, StructuredLogger.ToSink(line => lines.push(line)))
        assert.ok(delay.Waits >= Math.floor(StateLock.StaleMs / StateLock.RetryMs), String(delay.Waits))
        assert.equal(lines.length, 1)
        assert.ok(lines[0].includes('waiting until its lock goes stale'))
    })

    it('a lock lost to another agent stops everything and exits 1 without touching the lock', async () =>
    {
        const state = fresh()
        const f = new ShutdownFixture()
        const lock = new StateLock(state.Files, f.Clock)
        await lock.Acquire()
        const host = new FakeProcess()
        const shutdown = new HostAgentShutdown(lock, new NullLogger(), host)
        const loop = new Stopped()
        shutdown.Add(loop)
        shutdown.Abandon()
        assert.equal(loop.Stops, 1)
        assert.deepEqual(host.Exits, [1])
        assert.ok(await state.Files.ReadText(state.Files.Path(StateLock.FileName)) !== undefined)
    })
})
