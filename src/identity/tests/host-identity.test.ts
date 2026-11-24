import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { HostIdentity, HostIdentityUnusableError } from '../host-identity.js'
import { TempState } from '../../tests/fakes.js'

describe('HostIdentity', () =>
{
    const states: TempState[] = []
    after(() => states.forEach(state => state.Dispose()))
    const fresh = (): TempState =>
    {
        const state = new TempState()
        states.push(state)
        return state
    }

    it('creates the host key once as PKCS#8 PEM, mode 0600, and loads the same key on every start', async () =>
    {
        const state = fresh()
        const first = await HostIdentity.LoadOrCreate(state.Files)
        const path = state.Files.Path(HostIdentity.KeyFile)
        if (process.platform !== 'win32')
        {
            assert.equal(statSync(path).mode & 0o777, 0o600)
        }
        const second = await HostIdentity.LoadOrCreate(state.Files)
        assert.equal(second.KeyId, first.KeyId)
        assert.ok(!String(first).includes('PRIVATE KEY'), 'the key never prints its private half')
    })

    it('never replaces a key file that holds no usable key', async () =>
    {
        const state = fresh()
        writeFileSync(state.Files.Path(HostIdentity.KeyFile), 'not a key')
        await assert.rejects(HostIdentity.LoadOrCreate(state.Files), HostIdentityUnusableError)
    })
})
