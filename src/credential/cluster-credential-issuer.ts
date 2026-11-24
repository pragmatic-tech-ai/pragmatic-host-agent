import { ClusterCredentialHandover, type IProtocolClock, type Participant, type SealingPublicKey } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHostedKube } from '../kube/hosted-kube.js'

/** The sealed handover would exceed the 64 KiB the platform takes (a kubeconfig is a few KiB): nothing was sent. */
export class CredentialTooLargeError extends Error
{
    private static readonly ErrorName = 'CredentialTooLargeError'
    private static readonly Text = 'the sealed cluster credential exceeds 64 KiB'

    public constructor()
    {
        super(CredentialTooLargeError.Text)
        this.name = CredentialTooLargeError.ErrorName
    }
}

/** What one credential handover is for. */
export class CredentialSubject
{
    public constructor(
        public readonly Host: Participant,
        public readonly PlacementId: string,
        public readonly MeshAddress: string,
        public readonly ApiServerPort: number,
        public readonly SealingKey: SealingPublicKey)
    {
    }
}

/**
 * The platform's credential for one hosted cluster (C5.1): ServiceAccount `pragmatic-system/pragmatic-platform` bound to
 * `cluster-admin` (applied idempotently), a TokenRequest for it valid 7 days, and a kubeconfig of one cluster
 * (`https://<mesh address>:<port>` with the cluster's CA; the API server certificate carries the mesh address as a SAN),
 * one user (the token), one context, current-context set. Handed over only sealed to the platform's X25519 key
 * (ClusterCredentialHandover, rotation strictly increasing, at most 64 KiB); the token is in no log line and no file.
 * Rotated every 3 days (`RotationDue`).
 */
export class ClusterCredentialIssuer
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly ServiceAccount = 'pragmatic-platform'
    public static readonly Binding = 'pragmatic-platform-cluster-admin'
    public static readonly ClusterRole = 'cluster-admin'
    public static readonly TokenHours = 7 * 24
    public static readonly RotationMs = 3 * 24 * 60 * 60 * 1000
    public static readonly MaxHandoverBytes = 64 * 1024
    private static readonly HourMs = 60 * 60 * 1000
    private static readonly HttpsPrefix = 'https://'
    private static readonly PortSeparator = ':'
    private static readonly ContextName = 'pragmatic-platform'
    private static readonly ApiVersion = 'v1'
    private static readonly RbacApiVersion = 'rbac.authorization.k8s.io/v1'
    private static readonly RbacGroup = 'rbac.authorization.k8s.io'
    private static readonly ListKind = 'List'
    private static readonly NamespaceKind = 'Namespace'
    private static readonly ServiceAccountKind = 'ServiceAccount'
    private static readonly BindingKind = 'ClusterRoleBinding'
    private static readonly ClusterRoleKind = 'ClusterRole'
    private static readonly ConfigKind = 'Config'
    private static readonly ReferenceSeparator = '/'
    private static readonly NameSeparator = '-'
    private static readonly OpenBracket = '['
    private static readonly CloseBracket = ']'
    private static readonly CaKey = 'certificate-authority-data'

    public constructor(private readonly clock: IProtocolClock)
    {
    }

    /** Whether a credential issued at `issuedAt` (ISO, or null for none yet) is due for rotation now. */
    public RotationDue(issuedAt: string | null): boolean
    {
        if (issuedAt === null)
        {
            return true
        }
        return this.clock.Now().getTime() - Date.parse(issuedAt) >= ClusterCredentialIssuer.RotationMs
    }

    /** The ServiceAccount and its cluster-admin binding (kubectl apply: a re-run changes nothing). */
    public async EnsureAccount(kube: IHostedKube): Promise<void>
    {
        const C = ClusterCredentialIssuer
        await kube.Apply({
            apiVersion: C.ApiVersion,
            kind: C.ListKind,
            items: [
                { apiVersion: C.ApiVersion, kind: C.NamespaceKind, metadata: { name: C.Namespace } },
                { apiVersion: C.ApiVersion, kind: C.ServiceAccountKind, metadata: { name: C.ServiceAccount, namespace: C.Namespace } },
                {
                    apiVersion: C.RbacApiVersion, kind: C.BindingKind,
                    metadata: { name: C.Binding },
                    roleRef: { apiGroup: C.RbacGroup, kind: C.ClusterRoleKind, name: C.ClusterRole },
                    subjects: [{ kind: C.ServiceAccountKind, name: C.ServiceAccount, namespace: C.Namespace }],
                },
            ],
        })
    }

    /** A new credential, sealed: the handover to send, rotation number `rotation`, expiring with the token. */
    public async Issue(kube: IHostedKube, subject: CredentialSubject, rotation: number): Promise<ClusterCredentialHandover>
    {
        const C = ClusterCredentialIssuer
        await this.EnsureAccount(kube)
        const issued = this.clock.Now()
        const token = await kube.CreateToken(C.Namespace, C.ServiceAccount, C.TokenHours)
        const ca = await kube.CertificateAuthority()
        const kubeconfig = C.Kubeconfig(subject.MeshAddress, subject.ApiServerPort, ca, token, subject.PlacementId)
        const handover = ClusterCredentialHandover.Create({
            Host: subject.Host,
            PlacementId: subject.PlacementId,
            Rotation: rotation,
            ExpiresAt: new Date(issued.getTime() + C.TokenHours * C.HourMs),
            Credential: Buffer.from(kubeconfig),
            SealingKey: subject.SealingKey,
        })
        if (Buffer.byteLength(JSON.stringify(handover.ToJson())) > C.MaxHandoverBytes)
        {
            throw new CredentialTooLargeError()
        }
        return handover
    }

    /** The kubeconfig (JSON, which every kubeconfig reader takes as YAML) the platform reaches the cluster with. */
    public static Kubeconfig(meshAddress: string, port: number, certificateAuthority: string, token: string, placementId: string): string
    {
        const C = ClusterCredentialIssuer
        const cluster = ClusterCredentialHandover.ReferenceFor(placementId).replace(C.ReferenceSeparator, C.NameSeparator)
        const host = meshAddress.includes(C.PortSeparator) ? C.OpenBracket + meshAddress + C.CloseBracket : meshAddress
        return JSON.stringify({
            apiVersion: C.ApiVersion,
            kind: C.ConfigKind,
            clusters: [{ name: cluster, cluster: { server: C.HttpsPrefix + host + C.PortSeparator + String(port), [C.CaKey]: certificateAuthority } }],
            users: [{ name: C.ContextName, user: { token } }],
            contexts: [{ name: C.ContextName, context: { cluster, user: C.ContextName } }],
            'current-context': C.ContextName,
        })
    }
}
