import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../src/release-components.js'
import { ComponentGolden } from '../src/tests/component-golden.js'

/** The descriptor the image carries, pinned (it moves with the declaration and the package version). */
class DescriptorGoldenFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly App = ReleaseApp.HostAgent
    public static readonly Golden = join(DescriptorGoldenFixture.Here, '..', 'src', 'tests', 'fixtures', 'pragmatic-host-agent.component.json')
    public static readonly PinnedDigest = 'sha256:83e7d918ed60b4f55d4aa2a6879d81820d4817c00c8e2e97254ded550ed46756'
    public static readonly PackageJson = join(DescriptorGoldenFixture.Here, '..', 'package.json')
    public static readonly Utf8 = 'utf8'

    public static PackageVersion(): string
    {
        return (JSON.parse(readFileSync(DescriptorGoldenFixture.PackageJson, DescriptorGoldenFixture.Utf8)) as { version: string }).version
    }
}

describe('release component descriptor', () =>
{
    const F = DescriptorGoldenFixture

    it('the descriptor the release module emits has exactly the golden digest', () =>
    {
        ComponentGolden.Check(Components.Of(F.App), F.Golden, F.PinnedDigest)
    })

    it('the release module lists this one app', () =>
    {
        assert.deepEqual(Components.All().map(([app, descriptor]) => [app, descriptor.ContentDigest()]), [[F.App, F.PinnedDigest]])
    })

    it('the descriptor version is the package version', () =>
    {
        assert.equal(Components.Of(F.App).Version, F.PackageVersion())
    })

    it('declares the plan settings with their defaults, the code as a secret, no port and no storage', () =>
    {
        const descriptor = Components.Of(F.App).ToJson() as { options: { name: string; settings: { name: string; secret?: boolean; default?: unknown }[] }[]; ports?: unknown[] }
        const core = descriptor.options.find(option => option.name === 'core')
        assert.ok(core !== undefined)
        assert.deepEqual(core.settings.map(setting => setting.name), ['stateDir', 'channelUrl', 'machineName', 'meshAddress', 'hiveSlots', 'portRange', 'enrolmentCode', 'trustRootFile'])
        assert.equal(core.settings.find(setting => setting.name === 'enrolmentCode')?.secret, true)
        assert.equal(core.settings.find(setting => setting.name === 'channelUrl')?.default, 'https://agent.pragmatic-tech.ai')
        assert.equal(core.settings.find(setting => setting.name === 'hiveSlots')?.default, 4)
        assert.equal(core.settings.find(setting => setting.name === 'portRange')?.default, '16444-16463')
    })
})
