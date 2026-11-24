import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClusterAccess } from '../../cluster/cluster-driver.js'
import { ProcessFailedError } from '../../process/process-runner.js'
import { FakeProcessRunner } from '../../tests/fakes.js'
import { KubeconfigUnreadableError, KubectlHostedKube } from '../hosted-kube.js'

class KubeFixture
{
    public static readonly Access = new ClusterAccess('pragmatic-hosted-p1', '/state/clusters/pragmatic-hosted-p1/kubeconfig')
    public static readonly Prefix = ['kubectl', '--kubeconfig', '/state/clusters/pragmatic-hosted-p1/kubeconfig']
}

describe('KubectlHostedKube', () =>
{
    it('applies a manifest on standard input, never on the argument vector', async () =>
    {
        const runner = new FakeProcessRunner()
        await new KubectlHostedKube(runner, KubeFixture.Access).Apply({ kind: 'Secret', data: { code: 'c2VjcmV0' } })
        assert.deepEqual(runner.Argvs, [[...KubeFixture.Prefix, 'apply', '-f', '-']])
        assert.deepEqual(JSON.parse(runner.Commands[0].Stdin?.toString() ?? ''), { kind: 'Secret', data: { code: 'c2VjcmV0' } })
    })

    it('tells a missing ConfigMap from a failing kubectl', async () =>
    {
        const found = new KubectlHostedKube(new FakeProcessRunner(), KubeFixture.Access)
        assert.equal(await found.ConfigMapExists('pragmatic-system', 'pragmatic-hive-enrolment'), true)
        const missing = new FakeProcessRunner().OnPrefix(KubeFixture.Prefix, () => FakeProcessRunner.Fail('Error from server (NotFound): configmaps "pragmatic-hive-enrolment" not found'))
        assert.equal(await new KubectlHostedKube(missing, KubeFixture.Access).ConfigMapExists('pragmatic-system', 'pragmatic-hive-enrolment'), false)
        assert.deepEqual(missing.Argvs, [[...KubeFixture.Prefix, 'get', 'configmap', 'pragmatic-hive-enrolment', '--namespace', 'pragmatic-system', '-o', 'name']])
        const down = new FakeProcessRunner().OnPrefix(KubeFixture.Prefix, () => FakeProcessRunner.Fail('The connection to the server 127.0.0.1:16444 was refused'))
        await assert.rejects(new KubectlHostedKube(down, KubeFixture.Access).ConfigMapExists('pragmatic-system', 'x'), ProcessFailedError)
    })

    it('requests a token for the service account and reads the cluster CA from the raw kubeconfig', async () =>
    {
        const runner = new FakeProcessRunner()
            .OnPrefix([...KubeFixture.Prefix, 'create', 'token'], () => FakeProcessRunner.Ok('eyJtoken\n'))
            .OnPrefix([...KubeFixture.Prefix, 'config', 'view'], () => FakeProcessRunner.Ok(JSON.stringify({ clusters: [{ name: 'kind-x', cluster: { server: 'https://127.0.0.1:16444', 'certificate-authority-data': 'Q0E=' } }] })))
        const kube = new KubectlHostedKube(runner, KubeFixture.Access)
        assert.equal(await kube.CreateToken('pragmatic-system', 'pragmatic-platform', 168), 'eyJtoken')
        assert.equal(await kube.CertificateAuthority(), 'Q0E=')
        assert.deepEqual(runner.Argvs, [
            [...KubeFixture.Prefix, 'create', 'token', 'pragmatic-platform', '--namespace', 'pragmatic-system', '--duration', '168h'],
            [...KubeFixture.Prefix, 'config', 'view', '--raw', '-o', 'json'],
        ])
        const empty = new FakeProcessRunner().OnPrefix(KubeFixture.Prefix, () => FakeProcessRunner.Ok('{"clusters":[]}'))
        await assert.rejects(new KubectlHostedKube(empty, KubeFixture.Access).CertificateAuthority(), KubeconfigUnreadableError)
    })
})
