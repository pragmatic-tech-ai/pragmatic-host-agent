import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { ClusterCredentialHandover, MessageKind, PlacementFailure, PlacementOutcome, type PlacementResult } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ClusterNames } from '../../cluster/cluster-driver.js'
import { ClusterCredentialIssuer } from '../../credential/cluster-credential-issuer.js'
import { PlacementStep } from '../placement-record.js'
import { AcceptOutcome, PlacementReconciler } from '../placement-reconciler.js'
import { PlacementStore } from '../placement-store.js'
import { FakeHostedKube, KillingStore, KillPoint, PlacementFixture } from './placement-fixture.js'
import { FakeProcessRunner } from '../../tests/fakes.js'

class ReconcilerFixture
{
    public static readonly Kubeconfig = '/state/clusters/pragmatic-hosted-p1/kubeconfig'

    /** The helm upgrade argv of a first install (no --atomic) or an upgrade (--atomic) of placement p1. */
    public static HelmUpgrade(f: PlacementFixture, engineVersion: string, atomic: boolean): string[]
    {
        return [
            'helm', 'upgrade', '--install', 'pragmatic-engine', f.State.Files.Path('charts', 'pragmatic-hosted-p1', 'pragmatic-engine-' + engineVersion + '.tgz'),
            '--namespace', 'pragmatic-system', '--create-namespace',
            '--kubeconfig', ReconcilerFixture.Kubeconfig,
            '--set', 'hosted=true',
            '--set-string', 'level=connected',
            '--set-string', 'tenant.id=acme',
            '--set-string', 'console.host=acme-ab2c.hives.pragmatic-tech.ai',
            '--set-string', 'console.baseDomain=acme-ab2c.hives.pragmatic-tech.ai',
            '--set-string', 'console.address=relayed-hive-subdomain',
            '--set-string', 'tls.mode=self-signed',
            ...(atomic ? ['--atomic'] : []),
            '--wait', '--timeout', '15m',
        ]
    }

    public static Results(f: PlacementFixture): { Outcome: PlacementOutcome; Version: number; Failure: PlacementFailure | null }[]
    {
        return f.Platform.ReceivedOf<PlacementResult>(MessageKind.PlacementResult).map(r => ({ Outcome: r.Outcome, Version: r.Version, Failure: r.Failure }))
    }
}

describe('PlacementReconciler', () =>
{
    const fixtures: PlacementFixture[] = []
    after(() => fixtures.forEach(f => f.Dispose()))
    const enrolled = async (): Promise<PlacementFixture> =>
    {
        const f = await PlacementFixture.Enrolled()
        fixtures.push(f)
        return f
    }

    it('a placement runs cluster, engine, credential once and answers placed with its version', async () =>
    {
        const f = await enrolled()
        const result = await f.Reconciler().Reconcile(PlacementFixture.Place('p1'))
        assert.equal(result?.Outcome, PlacementOutcome.Placed)
        assert.equal(result?.Version, 1)
        assert.deepEqual(result?.ApiServer?.ToJson(), { Host: PlacementFixture.Mesh, Port: 16444 })
        assert.equal(result?.CredentialReference, 'clusters/p1')
        assert.equal(f.Driver.Creates.length, 1)
        assert.equal(f.Driver.Creates[0].Name, 'pragmatic-hosted-p1')
        assert.equal(f.Driver.Creates[0].HiveLabel, 'acme-ab2c')
        assert.equal(f.HelmRuns('upgrade').length, 1)
        const kubeconfig = JSON.parse(f.Platform.Credentials.get('clusters/p1')?.toString() ?? '{}') as Record<string, never>
        assert.deepEqual(kubeconfig['clusters'], [{ name: 'clusters-p1', cluster: { server: 'https://100.64.0.7:16444', 'certificate-authority-data': FakeHostedKube.CertificateAuthorityData } }])
        assert.deepEqual(kubeconfig['users'], [{ name: 'pragmatic-platform', user: { token: 'token-1' } }])
        assert.deepEqual(f.Platform.ReceivedOf<ClusterCredentialHandover>(MessageKind.ClusterCredentialHandover).map(h => h.Rotation), [1])
        const reconciler = f.Reconciler()
        await reconciler.SendResults()
        await reconciler.SendResults()
        assert.deepEqual(ReconcilerFixture.Results(f), [{ Outcome: PlacementOutcome.Placed, Version: 1, Failure: null }])
        assert.equal((await f.Store().Get('p1'))?.Json.PendingResult, null)
        assert.equal((await f.Store().Get('p1'))?.Step, PlacementStep.Placed)
    })

    for (const point of [KillPoint.AfterWrite, KillPoint.BeforeWrite])
    {
        it('killed ' + point + ' each write, a restart finishes placed and every repeated step was idempotent', async () =>
        {
            const clean = await enrolled()
            const counting = new KillingStore(clean.State.Files, Number.MAX_SAFE_INTEGER)
            await clean.Reconciler({ Store: counting }).Reconcile(PlacementFixture.Place('p1'))
            const writes = counting.Writes
            assert.ok(writes >= 7, String(writes))
            for (let killAt = 1; killAt <= writes; killAt += 1)
            {
                const f = await enrolled()
                const at = point + ' write ' + killAt
                await assert.rejects(f.Reconciler({ Store: new KillingStore(f.State.Files, killAt, point) }).Reconcile(PlacementFixture.Place('p1')), new RegExp(KillingStore.Killed))
                // The restart: a new reconciler over the same state directory; the platform delivers the request again.
                const restarted = f.Reconciler()
                await restarted.Accept(PlacementFixture.Place('p1'))
                await restarted.RunAll()
                const record = await f.Store().Get('p1')
                assert.equal(record?.Step, PlacementStep.Placed, at)
                assert.equal(record?.Json.EnrolmentCode, null, at)
                assert.equal(f.Driver.Clusters.size, 1, 'one cluster, ' + at)
                assert.ok(f.Driver.Creates.length <= 2 && f.Driver.Creates.every(spec => spec.ApiServerPort === 16444), 'a repeated create is the same cluster on the same port, ' + at)
                // A step killed before its record landed runs again; what it does again changes nothing.
                const upgrades = f.HelmRuns('upgrade')
                assert.ok(upgrades.length >= 1 && upgrades.length <= 2, at)
                assert.ok(upgrades.every(argv => JSON.stringify(argv) === JSON.stringify(ReconcilerFixture.HelmUpgrade(f, PlacementFixture.Version, false))), at)
                const secrets = f.Kube.Secrets()
                assert.ok(secrets.length >= 1 && secrets.length <= 2, at)
                assert.ok(secrets.every(secret => JSON.stringify(secret) === JSON.stringify(secrets[0])), 'the re-applied code Secret is the same, ' + at)
                const rotations = f.Platform.ReceivedOf<ClusterCredentialHandover>(MessageKind.ClusterCredentialHandover).map(h => h.Rotation)
                assert.ok(rotations.length >= 1, at)
                assert.ok(rotations.every((rotation, index) => index === 0 || rotation > rotations[index - 1]), 'rotations only rise, ' + at)
                assert.equal(record?.Json.Rotation, rotations[rotations.length - 1], at)
                await restarted.SendResults()
                assert.deepEqual(ReconcilerFixture.Results(f).map(r => r.Outcome), [PlacementOutcome.Placed], at)
            }
        })
    }

    it('allocates distinct ports and refuses when none is free', async () =>
    {
        const f = await enrolled()
        f.Probe.Busy.add(16445)
        const reconciler = f.Reconciler({ Ports: '16444-16446' })
        const results = []
        for (const id of ['p1', 'p2', 'p3'])
        {
            results.push(await reconciler.Reconcile(PlacementFixture.Place(id)))
        }
        assert.deepEqual(results.map(r => r?.ApiServer?.Port ?? null), [16444, 16446, null])
        assert.equal(results[2]?.Failure, PlacementFailure.NoCapacity)
        assert.deepEqual(f.Driver.Creates.map(spec => spec.ApiServerPort), [16444, 16446])
        await reconciler.Reconcile(PlacementFixture.Remove('p1'))
        assert.equal((await reconciler.Reconcile(PlacementFixture.Place('p4')))?.ApiServer?.Port, 16444)
    })

    it('two placements started together never share a port', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Accept(PlacementFixture.Place('p1'))
        await reconciler.Accept(PlacementFixture.Place('p2'))
        await reconciler.RunAll()
        assert.deepEqual(f.Driver.Creates.map(spec => spec.ApiServerPort).sort(), [16444, 16445])
    })

    it('a host at its slot limit refuses the placement no-capacity and creates nothing', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler({ Slots: 1 })
        assert.equal((await reconciler.Reconcile(PlacementFixture.Place('p1')))?.Outcome, PlacementOutcome.Placed)
        const refused = await reconciler.Reconcile(PlacementFixture.Place('p2'))
        assert.equal(refused?.Failure, PlacementFailure.NoCapacity)
        assert.equal(f.Driver.Creates.length, 1)
    })

    it('the chart is installed with hosted=true, the hive base domain and the code Secret, never the code on argv; the code leaves the record at once', async () =>
    {
        const f = await enrolled()
        const code = 'secret-enrolment-code-0123456789'
        // Stop right after the code Secret: the record no longer holds the code, before helm ran.
        f.Helm.On(command => command.Program === 'helm' && command.Args[0] === 'upgrade', () => { throw new Error('stop after the Secret') })
        const reconciler = f.Reconciler()
        await reconciler.Accept(PlacementFixture.Place('p1', PlacementFixture.Version, PlacementFixture.Digest, code))
        await reconciler.Run('p1').catch(() => undefined)
        assert.equal((await f.Store().Get('p1'))?.Json.EnrolmentCode, null)
        assert.deepEqual(f.Kube.Secrets(), [{ name: 'pragmatic-hive-enrolment-code', namespace: 'pragmatic-system', data: { code: Buffer.from(code).toString('base64') } }])
        for (const argv of f.Helm.Argvs)
        {
            assert.ok(!argv.some(part => part.includes(code)), argv.join(' '))
        }
        assert.deepEqual(f.HelmRuns('pull')[0], ['helm', 'pull', 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine', '--version', PlacementFixture.Version, '--destination', f.State.Files.Path('charts', 'pragmatic-hosted-p1')])
        assert.deepEqual(f.HelmRuns('upgrade')[0], ReconcilerFixture.HelmUpgrade(f, PlacementFixture.Version, false))
        assert.equal(f.Helm.Commands.find(command => command.Args[0] === 'upgrade')?.TimeoutMs, 20 * 60 * 1000, 'the helm process outlives its own 15m wait')
    })

    it('refuses a chart whose pulled digest differs, installing nothing', async () =>
    {
        const f = await enrolled()
        f.ChartDigests.set(PlacementFixture.Version, 'sha256:' + 'c'.repeat(64))
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        for (let attempt = 1; attempt < PlacementReconciler.MaxAttempts; attempt += 1)
        {
            await reconciler.RunAll()
        }
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Failed)
        assert.equal(record?.Json.PendingResult?.Failure, PlacementFailure.EngineInstallFailed)
        assert.equal(f.HelmRuns('upgrade').length, 0)
        assert.deepEqual(f.Driver.Deletes, ['pragmatic-hosted-p1'])
        assert.equal(record?.Json.Port, null)
    })

    it('a newer placement version with a new engine runs helm upgrade --atomic only, never the code Secret again', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        // The same version again changes nothing.
        assert.equal(await reconciler.Accept(PlacementFixture.Place('p1')), AcceptOutcome.Ignored)
        const upgraded = await reconciler.Reconcile(PlacementFixture.Place('p1', PlacementFixture.NewVersion, PlacementFixture.NewDigest, 'already-redeemed-code-0123', 2))
        assert.equal(upgraded?.Outcome, PlacementOutcome.Placed)
        assert.equal(upgraded?.Version, 2)
        assert.deepEqual(f.HelmRuns('upgrade'), [ReconcilerFixture.HelmUpgrade(f, PlacementFixture.Version, false), ReconcilerFixture.HelmUpgrade(f, PlacementFixture.NewVersion, true)])
        assert.equal(f.Driver.Creates.length, 1)
        assert.equal(f.Kube.Secrets().length, 1, 'no new code Secret on an upgrade')
        const record = await f.Store().Get('p1')
        assert.equal(record?.Json.InstalledVersion, PlacementFixture.NewVersion)
        assert.equal(record?.Json.EnrolmentCode, null)
        assert.equal(f.Platform.ReceivedOf(MessageKind.ClusterCredentialHandover).length, 1)
    })

    it('a failed upgrade (rolled back) answers failed and keeps the installed engine', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        f.Helm.On(command => command.Program === 'helm' && command.Args.includes('--atomic'), () => FakeProcessRunner.Fail('UPGRADE FAILED: rolled back'))
        await reconciler.Reconcile(PlacementFixture.Place('p1', PlacementFixture.NewVersion, PlacementFixture.NewDigest, 'already-redeemed-code-0123', 2))
        for (let attempt = 1; attempt < PlacementReconciler.MaxAttempts; attempt += 1)
        {
            await reconciler.RunAll()
        }
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Placed)
        assert.equal(record?.Json.InstalledVersion, PlacementFixture.Version)
        assert.equal(record?.Json.EngineVersion, PlacementFixture.Version)
        assert.equal(record?.Json.PendingResult?.Failure, PlacementFailure.EngineInstallFailed)
        assert.equal(record?.Json.PendingResult?.Version, 2)
    })

    it('an older placement version delivered late (a restore) is refused; a re-sent result carries the version', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1', PlacementFixture.NewVersion, PlacementFixture.NewDigest, 'code-0123456789abcdef', 3))
        assert.equal(await reconciler.Accept(PlacementFixture.Place('p1', PlacementFixture.Version, PlacementFixture.Digest, 'code-0123456789abcdef', 2)), AcceptOutcome.Ignored)
        await reconciler.RunAll()
        assert.equal((await f.Store().Get('p1'))?.Json.InstalledVersion, PlacementFixture.NewVersion)
        // The platform does not acknowledge the first send: the result is sent again, with the version.
        const wire = f.Wire
        const exchange = wire.Exchange.bind(wire)
        let refuse = true
        wire.Exchange = request => (refuse && request.Kind === MessageKind.PlacementResult ? (refuse = false, Promise.reject(new Error('lost'))) : exchange(request))
        await reconciler.SendResults()
        await reconciler.SendResults()
        assert.deepEqual(ReconcilerFixture.Results(f), [{ Outcome: PlacementOutcome.Placed, Version: 3, Failure: null }])
    })

    it('remove deletes the cluster, its charts and files and frees the port; an unknown placement answers removed; finished records are pruned', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        assert.ok(existsSync(f.State.Files.Path('charts', 'pragmatic-hosted-p1')))
        const removed = await reconciler.Reconcile(PlacementFixture.Remove('p1', 2))
        assert.equal(removed?.Outcome, PlacementOutcome.Removed)
        assert.equal(removed?.Version, 2)
        assert.deepEqual(f.Driver.Deletes, [ClusterNames.For('p1')])
        assert.equal(existsSync(f.State.Files.Path('charts', 'pragmatic-hosted-p1')), false)
        assert.equal((await f.Store().Get('p1'))?.Active, false)
        assert.equal((await reconciler.Reconcile(PlacementFixture.Remove('never-held', 1)))?.Outcome, PlacementOutcome.Removed)
        await reconciler.SendResults()
        assert.equal(await f.Store().Get('p1'), undefined, 'pruned once its result was acknowledged')
        assert.equal(await f.Store().Get('never-held'), undefined)
        assert.equal(await f.Store().TombstoneOf('p1'), 2)
        // A late Place, or the same removal again, for the pruned placement changes nothing.
        assert.equal(await reconciler.Accept(PlacementFixture.Place('p1', PlacementFixture.Version, PlacementFixture.Digest, 'code-0123456789abcdef', 3)), AcceptOutcome.Ignored)
        assert.equal(await reconciler.Accept(PlacementFixture.Remove('p1', 2)), AcceptOutcome.Ignored)
        assert.equal(f.Driver.Creates.length, 1)
    })

    it('credentials rotate every 3 days with an increasing number', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        f.Platform.Clock.Advance(ClusterCredentialIssuer.RotationMs - 60_000)
        await reconciler.RotateCredentials()
        f.Platform.Clock.Advance(60_000)
        await reconciler.RotateCredentials()
        await reconciler.RotateCredentials()
        f.Platform.Clock.Advance(ClusterCredentialIssuer.RotationMs)
        await reconciler.RotateCredentials()
        const handovers = f.Platform.ReceivedOf<ClusterCredentialHandover>(MessageKind.ClusterCredentialHandover)
        assert.deepEqual(handovers.map(h => h.Rotation), [1, 2, 3])
        assert.equal(handovers[2].ExpiresAt.getTime() - f.Platform.Clock.Now().getTime(), ClusterCredentialIssuer.TokenHours * 3_600_000)
        assert.equal((await f.Store().Get('p1'))?.Json.Rotation, 3)
    })

    it('a credential that cannot be issued fails the placement credential-failed after its attempts', async () =>
    {
        const f = await enrolled()
        f.Kube.FailTokens = true
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        for (let attempt = 1; attempt < PlacementReconciler.MaxAttempts; attempt += 1)
        {
            await reconciler.RunAll()
        }
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Failed)
        assert.equal(record?.Json.PendingResult?.Failure, PlacementFailure.CredentialFailed)
    })

    it('the enrolment is checked once per pass until its recorded deadline, then fails enrolment-failed', async () =>
    {
        const f = await enrolled()
        f.Kube.NotEnrolled.add('pragmatic-hosted-p1')
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        assert.equal(f.Kube.Polls, 1)
        const waiting = await f.Store().Get('p1')
        assert.equal(waiting?.Step, PlacementStep.Enrolment)
        assert.equal(Date.parse(waiting?.Json.EnrolmentDeadline ?? '') - f.Platform.Clock.Now().getTime(), PlacementReconciler.EnrolmentTimeoutMs)
        await reconciler.RunAll()
        assert.equal(f.Kube.Polls, 2)
        f.Platform.Clock.Advance(PlacementReconciler.EnrolmentTimeoutMs)
        await reconciler.RunAll()
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Failed)
        assert.equal(record?.Json.PendingResult?.Failure, PlacementFailure.EnrolmentFailed)
        assert.deepEqual(f.Driver.Deletes, ['pragmatic-hosted-p1'])
    })

    it('a placement waiting for enrolment does not delay another placement\'s removal', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p2'))
        f.Kube.NotEnrolled.add('pragmatic-hosted-p1')
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        await reconciler.Accept(PlacementFixture.Remove('p2'))
        await reconciler.RunAll()
        assert.equal((await f.Store().Get('p2'))?.Step, PlacementStep.Removed)
        assert.equal((await f.Store().Get('p1'))?.Step, PlacementStep.Enrolment)
        assert.equal(f.Kube.Polls, 3, 'p2 once; the waiting p1 once per pass, not in a loop')
    })

    it('a request for a placement being worked on is taken on a later pull (busy)', async () =>
    {
        const f = await enrolled()
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const create = f.Driver.Create.bind(f.Driver)
        f.Driver.Create = async spec => { await gate; return create(spec) }
        const reconciler = f.Reconciler()
        await reconciler.Accept(PlacementFixture.Place('p1'))
        const running = reconciler.Run('p1')
        assert.equal(await reconciler.Accept(PlacementFixture.Remove('p1')), AcceptOutcome.Busy)
        release()
        await running
        assert.equal(await reconciler.Accept(PlacementFixture.Remove('p1')), AcceptOutcome.Recorded)
    })

    it('one unreadable placement file does not stop the others', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        writeFileSync(f.State.Files.Path('placements', 'broken.json'), '{ not json')
        const store = new PlacementStore(f.State.Files)
        assert.deepEqual((await store.All()).map(record => record.Id), ['p1'])
        assert.deepEqual(store.Unreadable, ['broken'])
        await f.Reconciler({ Store: store }).RunAll()
        await f.Reconciler({ Store: store }).SendResults()
        assert.equal((await store.Get('p1'))?.Step, PlacementStep.Placed)
    })
})
