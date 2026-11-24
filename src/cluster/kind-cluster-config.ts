import type { ClusterSpec } from './cluster-driver.js'

/** One API-server command-line flag kubeadm passes (`--<Name>=<Value>`). */
export class ApiServerArg
{
    public constructor(public readonly Name: string, public readonly Value: string)
    {
    }
}

/**
 * The kind cluster configuration of one hosted cluster (kind.x-k8s.io/v1alpha4): one control-plane node of the pinned
 * kindest/node image, the API server on 127.0.0.1:<allocated port> (no extraPortMappings: several clusters share the
 * machine, and each one's ingress is reached through its own node), and kubeadm JSON 6902 patches that append to the
 * generated ClusterConfiguration (v1beta4, what kind generates for Kubernetes 1.36 and later): the mesh address as an
 * API-server certificate SAN, and every flag `ApiServerExtraArgs` names. Values are written as JSON strings (valid YAML).
 */
export class KindClusterConfig
{
    /** Kubernetes 1.37.0, the default node image of kind v0.33.0 (the release notes' digest). */
    public static readonly NodeImage = 'kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
    public static readonly ApiServerAddress = '127.0.0.1'
    /** The kubeadm API kind generates for the pinned node image (>= 1.36): extraArgs are name/value lists there. */
    public static readonly KubeadmVersion = 'v1beta4'
    private static readonly Newline = '\n'

    public constructor(private readonly nodeImage: string = KindClusterConfig.NodeImage)
    {
    }

    /**
     * The API server flags this cluster adds to kind's own, in order. None today; lane b5 (workload identity, Task 7)
     * answers `service-account-issuer` and `service-account-jwks-uri` here from `spec.HiveLabel`.
     */
    public ApiServerExtraArgs(spec: ClusterSpec): ApiServerArg[]
    {
        void spec
        return []
    }

    /** The JSON 6902 operations on kind's generated ClusterConfiguration: append the SAN, then each extra flag. */
    public KubeadmPatch(spec: ClusterSpec): readonly Record<string, unknown>[]
    {
        const operations: Record<string, unknown>[] = [{ op: 'add', path: '/apiServer/certSANs/-', value: spec.MeshAddress }]
        for (const arg of this.ApiServerExtraArgs(spec))
        {
            operations.push({ op: 'add', path: '/apiServer/extraArgs/-', value: { name: arg.Name, value: arg.Value } })
        }
        return operations
    }

    public Render(spec: ClusterSpec): string
    {
        const K = KindClusterConfig
        const q = (value: string | number): string => JSON.stringify(value)
        return [
            'kind: Cluster',
            'apiVersion: kind.x-k8s.io/v1alpha4',
            'name: ' + q(spec.Name),
            'networking:',
            '  apiServerAddress: ' + q(K.ApiServerAddress),
            '  apiServerPort: ' + String(spec.ApiServerPort),
            'nodes:',
            '  - role: control-plane',
            '    image: ' + q(this.nodeImage),
            'kubeadmConfigPatchesJSON6902:',
            '  - group: kubeadm.k8s.io',
            '    version: ' + K.KubeadmVersion,
            '    kind: ClusterConfiguration',
            '    patch: |',
            '      ' + JSON.stringify(this.KubeadmPatch(spec)),
            '',
        ].join(K.Newline)
    }
}
