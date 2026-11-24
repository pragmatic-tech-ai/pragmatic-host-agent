import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { StateLock, StateLockHeldError, type IProcessTable } from '../state-lock.js'
import { TempState } from '../../tests/fakes.js'

class FakeProcesses implements IProcessTable
{
    public readonly Alive = new Set<number>()

    public constructor(public readonly OwnPid: number)
    {
        this.Alive.add(OwnPid)
    }

    public IsAlive(pid: number): boolean
    {
        return this.Alive.has(pid)
    }
}

class LockFixture
{
    public Now = new Date('2026-11-25T10:00:00.000Z')
    public readonly Clock = (): Date => this.Now
}

describe('StateLock', () =>
{
    const states: TempState[] = []
    after(() => states.forEach(state => state.Dispose()))
    const fresh = (): TempState =>
    {
        const state = new TempState()
        states.push(state)
        return state
    }

    it('a second agent on the same state directory refuses to start', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        const shared = new FakeProcesses(1)
        await new StateLock(state.Files, f.Clock, shared).Acquire()
        // Another container: its pid 1 is alive too, and the heartbeat is fresh.
        await assert.rejects(new StateLock(state.Files, f.Clock, new FakeProcesses(1)).Acquire(), StateLockHeldError)
        const other = new FakeProcesses(7)
        other.Alive.add(1)
        await assert.rejects(new StateLock(state.Files, f.Clock, other).Acquire(), StateLockHeldError)
    })

    it('takes over a stale lock: an old heartbeat, or a dead holder in the same process table', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        await new StateLock(state.Files, f.Clock, new FakeProcesses(40)).Acquire()
        // The holder (pid 40) died: a process in the same table sees it gone and takes the lock at once.
        await new StateLock(state.Files, f.Clock, new FakeProcesses(41)).Acquire()
        const holder = new StateLock(state.Files, f.Clock, new FakeProcesses(1))
        f.Now = new Date(f.Now.getTime() + StateLock.StaleMs + 1)
        await holder.Acquire()
        // The holder keeps it fresh; an unreadable lock file is stale.
        await holder.Refresh()
        writeFileSync(state.Files.Path(StateLock.FileName), 'garbage')
        await new StateLock(state.Files, f.Clock, new FakeProcesses(1)).Acquire()
    })

    it('a holder whose lock was taken over learns it on its next refresh', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        const first = new StateLock(state.Files, f.Clock, new FakeProcesses(1))
        await first.Acquire()
        f.Now = new Date(f.Now.getTime() + StateLock.StaleMs + 1)
        await new StateLock(state.Files, f.Clock, new FakeProcesses(1)).Acquire()
        await assert.rejects(first.Refresh(), StateLockHeldError)
    })
})
