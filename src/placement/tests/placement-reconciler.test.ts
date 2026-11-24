import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
    ClusterCredentialHandover, MessageKind, PlacementFailure, PlacementOutcome, PlacementRequest, type PlacementResult,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ClusterNames } from '../../cluster/cluster-driver.js'
import { ClusterCredentialIssuer } from '../../credential/cluster-credential-issuer.js'
import { PlacementStep } from '../placement-record.js'
import { PlacementReconciler } from '../placement-reconciler.js'
import { FakeHostedKube, KillingStore, PlacementFixture } from './placement-fixture.js'

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

    it('a placement runs cluster, engine, credential once and answers placed', async () =>
    {
        const f = await enrolled()
        const result = await f.Reconciler().Reconcile(PlacementFixture.Place('p1'))
        assert.equal(result?.Outcome, PlacementOutcome.Placed)
        assert.deepEqual(result?.ApiServer?.ToJson(), { Host: PlacementFixture.Mesh, Port: 16444 })
        assert.equal(result?.CredentialReference, 'clusters/p1')
        assert.equal(f.Driver.Creates.length, 1)
        assert.equal(f.Driver.Creates[0].Name, 'pragmatic-hosted-p1')
        assert.equal(f.Driver.Creates[0].ApiServerPort, 16444)
        assert.equal(f.Driver.Creates[0].MeshAddress, PlacementFixture.Mesh)
        assert.equal(f.Driver.Creates[0].HiveLabel, 'acme-ab2c')
        assert.equal(f.HelmRuns('upgrade').length, 1)
        // The credential the platform opened: one cluster at the mesh address, the cluster's CA, the token, one context.
        const kubeconfig = JSON.parse(f.Platform.Credentials.get('clusters/p1')?.toString() ?? '{}') as Record<string, never>
        assert.deepEqual(kubeconfig['clusters'], [{ name: 'clusters-p1', cluster: { server: 'https://100.64.0.7:16444', 'certificate-authority-data': FakeHostedKube.CertificateAuthorityData } }])
        assert.deepEqual(kubeconfig['users'], [{ name: 'pragmatic-platform', user: { token: 'token-1' } }])
        assert.equal(kubeconfig['current-context'], 'pragmatic-platform')
        const handovers = f.Platform.ReceivedOf<ClusterCredentialHandover>(MessageKind.ClusterCredentialHandover)
        assert.deepEqual(handovers.map(h => h.Rotation), [1])
        // The result is sent once acknowledged and then cleared.
        const reconciler = f.Reconciler()
        await reconciler.SendResults()
        await reconciler.SendResults()
        assert.deepEqual(f.Platform.ReceivedOf<PlacementResult>(MessageKind.PlacementResult).map(r => r.Outcome), [PlacementOutcome.Placed])
        assert.equal((await f.Store().Get('p1'))?.Json.PendingResult, null)
        assert.equal((await f.Store().Get('p1'))?.Step, PlacementStep.Placed)
    })

    it('killed after each step, a restart finishes once', async () =>
    {
        // Count the writes of an undisturbed run, then kill a run after each one of them in turn.
        const clean = await enrolled()
        let writes = 0
        class CountingStore extends KillingStore
        {
            public override async Put(record: Parameters<KillingStore['Put']>[0]): Promise<void>
            {
                writes += 1
                await super.Put(record)
            }
        }
        await clean.Reconciler({ Store: new CountingStore(clean.State.Files, Number.MAX_SAFE_INTEGER) }).Reconcile(PlacementFixture.Place('p1'))
        assert.ok(writes >= 6, String(writes))
        for (let killAt = 1; killAt <= writes; killAt += 1)
        {
            const f = await enrolled()
            const request = PlacementFixture.Place('p1')
            await assert.rejects(f.Reconciler({ Store: new KillingStore(f.State.Files, killAt) }).Reconcile(request), new RegExp(KillingStore.Killed))
            // The restart: a new reconciler over the same state directory picks up from the recorded step.
            const restarted = f.Reconciler()
            await restarted.RunAll()
            const record = await f.Store().Get('p1')
            assert.equal(record?.Step, PlacementStep.Placed, 'killAt ' + killAt)
            assert.equal(f.Driver.Creates.length, 1, 'one cluster create, killAt ' + killAt)
            assert.equal(f.HelmRuns('upgrade').length, 1, 'one helm install, killAt ' + killAt)
            assert.equal(f.Kube.Secrets().length, 1, 'one code Secret, killAt ' + killAt)
            const rotations = f.Platform.ReceivedOf<ClusterCredentialHandover>(MessageKind.ClusterCredentialHandover).map(h => h.Rotation)
            assert.equal(rotations.length, 1, 'one handover, killAt ' + killAt)
            assert.equal(record?.Json.Rotation, rotations[0], 'the recorded rotation is the one handed over, killAt ' + killAt)
            await restarted.SendResults()
            assert.deepEqual(f.Platform.ReceivedOf<PlacementResult>(MessageKind.PlacementResult).map(r => r.Outcome), [PlacementOutcome.Placed], 'killAt ' + killAt)
        }
    })

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
        assert.equal(results[2]?.Outcome, PlacementOutcome.Failed)
        assert.equal(results[2]?.Failure, PlacementFailure.NoCapacity)
        assert.deepEqual(f.Driver.Creates.map(spec => spec.ApiServerPort), [16444, 16446])
        // A removal frees its port for the next placement.
        await reconciler.Reconcile(PlacementRequest.Remove('p1', PlacementFixture.Tenant))
        assert.equal((await reconciler.Reconcile(PlacementFixture.Place('p4')))?.ApiServer?.Port, 16444)
    })

    it('a host at its slot limit refuses the placement no-capacity and creates nothing', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler({ Slots: 1 })
        assert.equal((await reconciler.Reconcile(PlacementFixture.Place('p1')))?.Outcome, PlacementOutcome.Placed)
        const refused = await reconciler.Reconcile(PlacementFixture.Place('p2'))
        assert.equal(refused?.Failure, PlacementFailure.NoCapacity)
        assert.equal(f.Driver.Creates.length, 1)
        assert.equal((await f.Store().Get('p2'))?.Json.Port, null)
    })

    it('the chart is installed with hosted=true and the code Secret, never the code on argv', async () =>
    {
        const f = await enrolled()
        const code = 'secret-enrolment-code-0123456789'
        await f.Reconciler().Reconcile(PlacementFixture.Place('p1', PlacementFixture.Version, PlacementFixture.Digest, code))
        assert.deepEqual(f.Kube.Secrets(), [{ name: 'pragmatic-hive-enrolment-code', namespace: 'pragmatic-system', data: { code: Buffer.from(code).toString('base64') } }])
        for (const argv of [...f.Helm.Argvs])
        {
            assert.ok(!argv.some(part => part.includes(code)), argv.join(' '))
        }
        const dir = f.State.Files.Path('charts', 'pragmatic-hosted-p1')
        assert.deepEqual(f.HelmRuns('pull'), [['helm', 'pull', 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine', '--version', PlacementFixture.Version, '--destination', dir]])
        assert.deepEqual(f.HelmRuns('upgrade'), [[
            'helm', 'upgrade', '--install', 'pragmatic-engine', f.State.Files.Path('charts', 'pragmatic-hosted-p1', 'pragmatic-engine-' + PlacementFixture.Version + '.tgz'),
            '--namespace', 'pragmatic-system', '--create-namespace',
            '--kubeconfig', '/state/clusters/pragmatic-hosted-p1/kubeconfig',
            '--set', 'hosted=true',
            '--set-string', 'level=connected',
            '--set-string', 'tenant.id=acme',
            '--set-string', 'console.host=acme-ab2c.hives.pragmatic-tech.ai',
            '--set-string', 'console.address=relayed-hive-subdomain',
            '--set-string', 'tls.mode=self-signed',
            '--wait', '--timeout', '15m',
        ]])
        // The code is dropped from the record once it is in the cluster.
        assert.equal((await f.Store().Get('p1'))?.Json.EnrolmentCode, null)
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
        assert.deepEqual(f.Driver.Deletes, ['pragmatic-hosted-p1'], 'the failed placement cluster is deleted')
        assert.equal(record?.Json.Port, null)
    })

    it('a newer engine version for a placed hive runs helm upgrade only', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        // The same request again answers placed and changes nothing.
        assert.equal((await reconciler.Reconcile(PlacementFixture.Place('p1')))?.Outcome, PlacementOutcome.Placed)
        assert.equal(f.HelmRuns('upgrade').length, 1)
        const upgraded = await reconciler.Reconcile(PlacementFixture.Place('p1', PlacementFixture.NewVersion, PlacementFixture.NewDigest, 'another-one-time-code-0123'))
        assert.equal(upgraded?.Outcome, PlacementOutcome.Placed)
        assert.equal(f.HelmRuns('upgrade').length, 2)
        assert.ok(f.HelmRuns('upgrade')[1].includes(f.State.Files.Path('charts', 'pragmatic-hosted-p1', 'pragmatic-engine-' + PlacementFixture.NewVersion + '.tgz')))
        assert.equal(f.Driver.Creates.length, 1)
        assert.equal(f.Kube.Secrets().length, 1, 'no new code Secret on an upgrade')
        const record = await f.Store().Get('p1')
        assert.equal(record?.Json.InstalledVersion, PlacementFixture.NewVersion)
        assert.equal(record?.Json.InstalledDigest, PlacementFixture.NewDigest)
        assert.equal(f.Platform.ReceivedOf(MessageKind.ClusterCredentialHandover).length, 1, 'an upgrade hands over no new credential')
    })

    it('remove deletes the cluster and frees the port; an unknown placement answers removed', async () =>
    {
        const f = await enrolled()
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        const removed = await reconciler.Reconcile(PlacementRequest.Remove('p1', PlacementFixture.Tenant))
        assert.equal(removed?.Outcome, PlacementOutcome.Removed)
        assert.deepEqual(f.Driver.Deletes, [ClusterNames.For('p1')])
        assert.equal(f.Driver.Clusters.size, 0)
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Removed)
        assert.equal(record?.Json.Port, null)
        assert.equal(record?.Active, false)
        // Removing again, or a placement never held, answers removed and deletes nothing more.
        assert.equal((await reconciler.Reconcile(PlacementRequest.Remove('p1', PlacementFixture.Tenant)))?.Outcome, PlacementOutcome.Removed)
        assert.equal((await reconciler.Reconcile(PlacementRequest.Remove('never-held', PlacementFixture.Tenant)))?.Outcome, PlacementOutcome.Removed)
        assert.deepEqual(f.Driver.Deletes, [ClusterNames.For('p1')])
        // A removed placement is never placed again under its id.
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
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
        // Each token lives 7 days from its issue.
        assert.equal(handovers[2].ExpiresAt.getTime() - f.Platform.Clock.Now().getTime(), ClusterCredentialIssuer.TokenHours * 3_600_000)
        assert.equal(JSON.parse(f.Platform.Credentials.get('clusters/p1')?.toString() ?? '{}').users[0].user.token, 'token-3')
        assert.equal((await f.Store().Get('p1'))?.Json.Rotation, 3)
    })

    it('waits for the hosted hive to enrol, bounded, and fails the placement enrolment-failed after its attempts', async () =>
    {
        const f = await enrolled()
        f.Kube.Enrolled = false
        const reconciler = f.Reconciler()
        await reconciler.Reconcile(PlacementFixture.Place('p1'))
        assert.equal(f.Kube.Polls, PlacementReconciler.EnrolmentPolls)
        assert.equal((await f.Store().Get('p1'))?.Step, PlacementStep.Enrolment)
        for (let attempt = 1; attempt < PlacementReconciler.MaxAttempts; attempt += 1)
        {
            await reconciler.RunAll()
        }
        const record = await f.Store().Get('p1')
        assert.equal(record?.Step, PlacementStep.Failed)
        assert.equal(record?.Json.PendingResult?.Failure, PlacementFailure.EnrolmentFailed)
        assert.deepEqual(f.Driver.Deletes, ['pragmatic-hosted-p1'])
    })
})
