import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { StateLock, StateLockHeldError } from '../state-lock.js'
import { TempState } from '../../tests/fakes.js'

class LockFixture
{
    public Now = new Date('2026-11-25T10:00:00.000Z')
    public readonly Clock = (): Date => this.Now

    public Advance(ms: number): void
    {
        this.Now = new Date(this.Now.getTime() + ms)
    }
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

    it('a second agent on the same state directory refuses to start while the holder heartbeats', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        const holder = new StateLock(state.Files, f.Clock)
        await holder.Acquire()
        await assert.rejects(new StateLock(state.Files, f.Clock).Acquire(), StateLockHeldError)
        f.Advance(StateLock.StaleMs - 1000)
        await holder.Refresh()
        f.Advance(StateLock.StaleMs - 1000)
        await assert.rejects(new StateLock(state.Files, f.Clock).Acquire(), StateLockHeldError)
    })

    it('a fresh lock naming a pid that is not alive here (another pid namespace) is never taken over', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        // A holder in another container: its pid means nothing in this one.
        writeFileSync(state.Files.Path(StateLock.FileName), JSON.stringify({ instance: 'other-container', pid: 999_999_999, heartbeat: f.Now.toISOString() }))
        await assert.rejects(new StateLock(state.Files, f.Clock).Acquire(), StateLockHeldError)
    })

    it('takes over a stale lock (old heartbeat, or unreadable), and the old holder learns it on its next refresh', async () =>
    {
        const state = fresh()
        const f = new LockFixture()
        const first = new StateLock(state.Files, f.Clock)
        await first.Acquire()
        f.Advance(StateLock.StaleMs + 1)
        const second = new StateLock(state.Files, f.Clock)
        await second.Acquire()
        await assert.rejects(first.Refresh(), StateLockHeldError)
        writeFileSync(state.Files.Path(StateLock.FileName), 'garbage')
        await new StateLock(state.Files, f.Clock).Acquire()
    })
})
