import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The host agent stays dependency-light: node built-ins and three shared packages (the hive protocol among them, itself dependency-free), no TODL, Mural or todl-runtime. */
class PackageDepsFixture
{
    public static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly PackageJson = 'package.json'
    public static readonly NodeModules = 'node_modules'
    public static readonly ScopePrefix = '@'
    public static readonly Utf8 = 'utf8'
    public static readonly Forbidden: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    public static readonly Dependencies: readonly string[] = [
        '@pragmatic-tech-ai/pragmatic-component', '@pragmatic-tech-ai/pragmatic-hive-protocol', '@pragmatic-tech-ai/pragmatic-observability',
    ]
    public static readonly DependencyFields: readonly string[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

    public static Manifest(): Record<string, unknown>
    {
        return JSON.parse(readFileSync(join(PackageDepsFixture.Root, PackageDepsFixture.PackageJson), PackageDepsFixture.Utf8)) as Record<string, unknown>
    }

    public static Declared(field: string): string[]
    {
        return Object.keys((PackageDepsFixture.Manifest()[field] ?? {}) as Record<string, string>)
    }

    /** Every installed package folder's name (nested copies included). */
    public static Installed(): string[]
    {
        const names: string[] = []
        PackageDepsFixture.Walk(join(PackageDepsFixture.Root, PackageDepsFixture.NodeModules), names)
        return names
    }

    private static Walk(modules: string, names: string[]): void
    {
        if (!existsSync(modules))
        {
            return
        }
        for (const entry of readdirSync(modules, { withFileTypes: true }))
        {
            if (!entry.isDirectory() || entry.name.startsWith('.'))
            {
                continue
            }
            const path = join(modules, entry.name)
            if (entry.name.startsWith(PackageDepsFixture.ScopePrefix))
            {
                PackageDepsFixture.Walk(path, names)
                continue
            }
            const manifest = join(path, PackageDepsFixture.PackageJson)
            if (existsSync(manifest))
            {
                names.push((JSON.parse(readFileSync(manifest, PackageDepsFixture.Utf8)) as { name?: string }).name ?? '')
            }
            PackageDepsFixture.Walk(join(path, PackageDepsFixture.NodeModules), names)
        }
    }
}

describe('package dependencies', () =>
{
    const F = PackageDepsFixture

    it('package.json declares no dependency on todl, todl-runtime or mural', () =>
    {
        for (const field of F.DependencyFields)
        {
            assert.deepEqual(F.Declared(field).filter(name => F.Forbidden.includes(name)), [], field)
        }
    })

    it('the runtime dependencies are exactly pragmatic-component, pragmatic-hive-protocol and pragmatic-observability', () =>
    {
        assert.deepEqual(F.Declared(F.DependencyFields[0]).sort(), [...F.Dependencies].sort())
    })

    it('no installed package is todl, todl-runtime or mural', () =>
    {
        assert.deepEqual(F.Installed().filter(name => F.Forbidden.includes(name)), [])
    })
})
