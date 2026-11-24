import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HostSettings, HostSettingsError, PortRange } from '../host-settings.js'

class SettingsFixture
{
    public static readonly Minimal: NodeJS.ProcessEnv = {
        PRAGMATIC_HOST_MACHINE_NAME: 'hive-laptop',
        PRAGMATIC_HOST_MESH_ADDRESS: '100.64.0.7',
        PRAGMATIC_HOST_TRUST_ROOT_FILE: '/etc/pragmatic/platform-signing-key.pub',
    }
}

describe('HostSettings', () =>
{
    it('takes the plan defaults: state dir, channel, 4 slots, ports 16444-16463', () =>
    {
        const settings = HostSettings.FromEnv(SettingsFixture.Minimal)
        assert.equal(settings.StateDir, '/var/lib/pragmatic-host-agent')
        assert.equal(settings.ChannelUrl, 'https://agent.pragmatic-tech.ai')
        assert.equal(settings.HiveSlots, 4)
        assert.deepEqual([settings.Ports.First, settings.Ports.Last, settings.Ports.Size], [16444, 16463, 20])
        assert.equal(settings.EnrolmentCodeFile, undefined)
    })

    it('an unconfigured start is refused naming every missing setting, with the start-smoke refusal prefix', () =>
    {
        assert.throws(() => HostSettings.FromEnv({}), (error: unknown) =>
            error instanceof HostSettingsError
            && error.message.startsWith('the host agent is not configured: ')
            && ['PRAGMATIC_HOST_MACHINE_NAME', 'PRAGMATIC_HOST_MESH_ADDRESS', 'PRAGMATIC_HOST_TRUST_ROOT_FILE'].every(name => error.message.includes(name)))
    })

    it('refuses a bad machine name, address, channel, slot count, port range and relative paths', () =>
    {
        const bad: NodeJS.ProcessEnv[] = [
            { PRAGMATIC_HOST_MACHINE_NAME: 'Hive Laptop' },
            { PRAGMATIC_HOST_MESH_ADDRESS: 'not an address!' },
            { PRAGMATIC_HOST_CHANNEL_URL: 'http://agent.pragmatic-tech.ai' },
            { PRAGMATIC_HOST_HIVE_SLOTS: '0' },
            { PRAGMATIC_HOST_HIVE_SLOTS: '21' },
            { PRAGMATIC_HOST_PORT_RANGE: '16463-16444' },
            { PRAGMATIC_HOST_STATE_DIR: 'state' },
            { PRAGMATIC_HOST_ENROLMENT_CODE_FILE: 'code' },
        ]
        for (const change of bad)
        {
            assert.throws(() => HostSettings.FromEnv({ ...SettingsFixture.Minimal, ...change }), HostSettingsError, JSON.stringify(change))
        }
    })

    it('parses a port range', () =>
    {
        assert.deepEqual(PortRange.Parse('16444-16445')?.Ports(), [16444, 16445])
        assert.equal(PortRange.Parse('0-10'), undefined)
        assert.equal(PortRange.Parse('16444'), undefined)
    })
})
