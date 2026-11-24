import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Participant, SealingKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { ClusterCredentialIssuer, CredentialSubject } from '../cluster-credential-issuer.js'
import { FakeHostedKube } from '../../placement/tests/placement-fixture.js'

describe('ClusterCredentialIssuer', () =>
{
    it('binds pragmatic-system/pragmatic-platform to cluster-admin and seals a 7-day kubeconfig at the mesh address', async () =>
    {
        const clock = new FakeClock()
        const sealing = SealingKeyPair.Generate()
        const fake = new FakeHostedKube()
        const kube = fake.Direct()
        const host = Participant.Host('host-1')
        const handover = await new ClusterCredentialIssuer(clock).Issue(kube, new CredentialSubject(host, 'p1', '100.64.0.7', 16450, sealing.PublicKey), 1)
        assert.equal(handover.Rotation, 1)
        assert.equal(handover.CredentialReference, 'clusters/p1')
        assert.equal(handover.ExpiresAt.getTime() - clock.Now().getTime(), 7 * 24 * 3_600_000)
        const items = (fake.Applied[0].Manifest as { items: { kind: string; metadata: { name: string; namespace?: string }; roleRef?: { name: string }; subjects?: unknown[] }[] }).items
        assert.deepEqual(items.map(item => item.kind), ['Namespace', 'ServiceAccount', 'ClusterRoleBinding'])
        assert.deepEqual(items[1].metadata, { name: 'pragmatic-platform', namespace: 'pragmatic-system' })
        assert.equal(items[2].roleRef?.name, 'cluster-admin')
        assert.deepEqual(items[2].subjects, [{ kind: 'ServiceAccount', name: 'pragmatic-platform', namespace: 'pragmatic-system' }])
        // Only the platform's sealing key, for this host and placement, opens it.
        const kubeconfig = JSON.parse(handover.Open(sealing, host).toString()) as Record<string, unknown>
        assert.deepEqual(kubeconfig, {
            apiVersion: 'v1',
            kind: 'Config',
            clusters: [{ name: 'clusters-p1', cluster: { server: 'https://100.64.0.7:16450', 'certificate-authority-data': FakeHostedKube.CertificateAuthorityData } }],
            users: [{ name: 'pragmatic-platform', user: { token: 'token-1' } }],
            contexts: [{ name: 'pragmatic-platform', context: { cluster: 'clusters-p1', user: 'pragmatic-platform' } }],
            'current-context': 'pragmatic-platform',
        })
        assert.throws(() => handover.Open(sealing, Participant.Host('host-2')))
        assert.throws(() => handover.Open(SealingKeyPair.Generate(), host))
        assert.ok(!JSON.stringify(handover.ToJson()).includes('token-1'), 'the token travels sealed only')
    })

    it('is due for rotation 3 days after the last issue, and at once when none was issued', () =>
    {
        const clock = new FakeClock()
        const issuer = new ClusterCredentialIssuer(clock)
        const issued = clock.Now().toISOString()
        assert.equal(issuer.RotationDue(null), true)
        assert.equal(issuer.RotationDue(issued), false)
        clock.Advance(ClusterCredentialIssuer.RotationMs - 1)
        assert.equal(issuer.RotationDue(issued), false)
        clock.Advance(1)
        assert.equal(issuer.RotationDue(issued), true)
    })

    it('brackets an IPv6 mesh address in the server URL', () =>
    {
        const kubeconfig = JSON.parse(ClusterCredentialIssuer.Kubeconfig('fd7a:115c:a1e0::7', 16444, 'Q0E=', 't', 'p1')) as { clusters: { cluster: { server: string } }[] }
        assert.equal(kubeconfig.clusters[0].cluster.server, 'https://[fd7a:115c:a1e0::7]:16444')
    })
})
