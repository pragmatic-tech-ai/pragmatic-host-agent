import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { ClusterSpec } from '../cluster-driver.js'
import { ApiServerArg, KindClusterConfig } from '../kind-cluster-config.js'
import { KindClusterDriver } from '../kind-cluster-driver.js'
import { ProcessFailedError } from '../../process/process-runner.js'
import { FakeProcessRunner, TempState } from '../../tests/fakes.js'

class KindFixture
{
    public static readonly Manifest = '/workspace/pragmatic-host-agent/vendor/ingress-nginx/deploy.yaml'
    public static readonly Spec = new ClusterSpec('pragmatic-hosted-p1', 16444, '100.64.0.7', 'acme-ab2c')
}

/** A config with one API-server flag, as lane b5's issuer flags will be added. */
class IssuerConfig extends KindClusterConfig
{
    public override ApiServerExtraArgs(spec: ClusterSpec): ApiServerArg[]
    {
        return [new ApiServerArg('service-account-issuer', 'https://' + spec.HiveLabel + '.issuer.example')]
    }
}

describe('KindClusterDriver', () =>
{
    const states: TempState[] = []
    after(() => states.forEach(state => state.Dispose()))
    const fresh = (): TempState =>
    {
        const state = new TempState()
        states.push(state)
        return state
    }

    it('creates the cluster, installs the vendored ingress-nginx as the default class and waits for it: argv exactly', async () =>
    {
        const state = fresh()
        const runner = new FakeProcessRunner().OnPrefix(['kind', 'get', 'clusters'], () => FakeProcessRunner.Ok('pragmatic-hive\n'))
        const access = await new KindClusterDriver(runner, state.Files, KindFixture.Manifest).Create(KindFixture.Spec)
        const config = state.Files.Path('clusters', 'pragmatic-hosted-p1', 'kind-config.yaml')
        const kubeconfig = state.Files.Path('clusters', 'pragmatic-hosted-p1', 'kubeconfig')
        assert.equal(access.KubeconfigPath, kubeconfig)
        assert.deepEqual(runner.Argvs, [
            ['kind', 'get', 'clusters'],
            ['kind', 'create', 'cluster', '--name', 'pragmatic-hosted-p1', '--config', config, '--kubeconfig', kubeconfig, '--wait', '5m'],
            ['kubectl', '--kubeconfig', kubeconfig, 'apply', '-f', KindFixture.Manifest],
            ['kubectl', '--kubeconfig', kubeconfig, 'annotate', '--overwrite', 'ingressclass/nginx', 'ingressclass.kubernetes.io/is-default-class=true'],
            ['kubectl', '--kubeconfig', kubeconfig, '--namespace', 'ingress-nginx', 'rollout', 'status', 'deployment/ingress-nginx-controller', '--timeout=300s'],
        ])
        assert.equal(readFileSync(config, 'utf8'), new KindClusterConfig().Render(KindFixture.Spec))
        assert.ok(runner.Commands.every(command => command.Stdin === undefined))
    })

    it('an existing cluster (a restart) is not created again: its kubeconfig is re-exported and the add-ons re-applied', async () =>
    {
        const state = fresh()
        const runner = new FakeProcessRunner().OnPrefix(['kind', 'get', 'clusters'], () => FakeProcessRunner.Ok('pragmatic-hive\npragmatic-hosted-p1\n'))
        await new KindClusterDriver(runner, state.Files, KindFixture.Manifest).Create(KindFixture.Spec)
        const kubeconfig = state.Files.Path('clusters', 'pragmatic-hosted-p1', 'kubeconfig')
        assert.deepEqual(runner.Argvs.slice(0, 3), [
            ['kind', 'get', 'clusters'],
            ['kind', 'export', 'kubeconfig', '--name', 'pragmatic-hosted-p1', '--kubeconfig', kubeconfig],
            ['kubectl', '--kubeconfig', kubeconfig, 'apply', '-f', KindFixture.Manifest],
        ])
        assert.ok(!runner.Argvs.some(argv => argv[1] === 'create'))
    })

    it('deletes the cluster and its files; a failing kind is an error naming the program', async () =>
    {
        const state = fresh()
        await state.Files.WriteText(state.Files.Path('clusters', 'pragmatic-hosted-p1', 'kubeconfig'), '{}')
        const runner = new FakeProcessRunner()
        await new KindClusterDriver(runner, state.Files, KindFixture.Manifest).Delete('pragmatic-hosted-p1')
        assert.deepEqual(runner.Argvs, [['kind', 'delete', 'cluster', '--name', 'pragmatic-hosted-p1']])
        assert.equal(await state.Files.ReadText(state.Files.Path('clusters', 'pragmatic-hosted-p1', 'kubeconfig')), undefined)
        const failing = new FakeProcessRunner().OnPrefix(['kind'], () => FakeProcessRunner.Fail('ERROR: failed to create cluster'))
        await assert.rejects(new KindClusterDriver(failing, state.Files, KindFixture.Manifest).Create(KindFixture.Spec),
            (error: unknown) => error instanceof ProcessFailedError && error.Program === 'kind' && error.message.includes('failed to create cluster'))
    })
})

describe('KindClusterConfig', () =>
{
    it('binds the API server on 127.0.0.1:<port>, pins the node image by digest, adds the mesh SAN and no port mappings', () =>
    {
        const text = new KindClusterConfig().Render(KindFixture.Spec)
        assert.equal(text, [
            'kind: Cluster',
            'apiVersion: kind.x-k8s.io/v1alpha4',
            'name: "pragmatic-hosted-p1"',
            'networking:',
            '  apiServerAddress: "127.0.0.1"',
            '  apiServerPort: 16444',
            'nodes:',
            '  - role: control-plane',
            '    image: "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"',
            'kubeadmConfigPatchesJSON6902:',
            '  - group: kubeadm.k8s.io',
            '    version: v1beta4',
            '    kind: ClusterConfiguration',
            '    patch: |',
            '      [{"op":"add","path":"/apiServer/certSANs/-","value":"100.64.0.7"}]',
            '',
        ].join('\n'))
        assert.ok(!text.includes('extraPortMappings'))
        assert.match(KindClusterConfig.NodeImage, /^kindest\/node:v1\.(3[0-9])\.\d+@sha256:[0-9a-f]{64}$/)
    })

    it('appends each API-server flag ApiServerExtraArgs names (the seam lane b5 fills from the hive label)', () =>
    {
        assert.deepEqual(new KindClusterConfig().ApiServerExtraArgs(KindFixture.Spec), [])
        assert.deepEqual(new IssuerConfig().KubeadmPatch(KindFixture.Spec), [
            { op: 'add', path: '/apiServer/certSANs/-', value: '100.64.0.7' },
            { op: 'add', path: '/apiServer/extraArgs/-', value: { name: 'service-account-issuer', value: 'https://acme-ab2c.issuer.example' } },
        ])
    })
})
