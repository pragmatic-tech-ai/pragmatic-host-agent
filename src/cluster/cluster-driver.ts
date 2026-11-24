import type { ClusterKind } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** What one hosted cluster is created with. */
export class ClusterSpec
{
    public constructor(
        /** `pragmatic-hosted-<placement id>` (ClusterNames.For). */
        public readonly Name: string,
        /** The API server's port on 127.0.0.1 (and, through the machine's port proxy, on the mesh address). */
        public readonly ApiServerPort: number,
        /** The machine's mesh address: a SAN of the API server's certificate, where the platform reaches it. */
        public readonly MeshAddress: string,
        /** The hive's label (the first label of the placement's HiveHostName, `<tenant>-<4 base32>`). */
        public readonly HiveLabel: string)
    {
    }
}

/** How the host agent reaches a cluster it created: its admin kubeconfig file on the machine (server 127.0.0.1:<port>). */
export class ClusterAccess
{
    public constructor(public readonly Name: string, public readonly KubeconfigPath: string)
    {
    }
}

/** The names the host agent gives its clusters. */
export class ClusterNames
{
    public static readonly Prefix = 'pragmatic-hosted-'

    private constructor()
    {
    }

    public static For(placementId: string): string
    {
        return ClusterNames.Prefix + placementId
    }
}

/**
 * Creates and deletes the hosted clusters on this machine (kind today; k3s is a declared ClusterKind with no driver yet).
 * Every operation is idempotent: Create on an existing cluster brings its add-ons to the same state and answers its
 * access, Delete of a missing cluster succeeds.
 */
export interface IClusterDriver
{
    readonly Kind: ClusterKind
    /** Creates the cluster with its API server on 127.0.0.1:<port>, an ingress controller and a default StorageClass. */
    Create(spec: ClusterSpec): Promise<ClusterAccess>
    /** The access of a cluster that exists (its kubeconfig re-exported). */
    Access(name: string): Promise<ClusterAccess>
    Delete(name: string): Promise<void>
}
