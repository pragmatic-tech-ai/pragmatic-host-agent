import { CheckedRunner, ProcessCommand, type IProcessRunner } from '../process/process-runner.js'
import type { ClusterAccess } from '../cluster/cluster-driver.js'
import type { IHostedKube } from '../kube/hosted-kube.js'
import type { StateFiles } from '../state/state-files.js'

/** The engine a placement asks for: the chart version (the release), its manifest digest, the tenant and the hive host. */
export class EngineTarget
{
    public constructor(
        public readonly EngineVersion: string,
        public readonly ChartDigest: string,
        public readonly Tenant: string,
        public readonly HiveHostName: string)
    {
    }
}

/** The pulled chart's manifest digest is not the placement's ChartDigest: nothing was installed. */
export class ChartDigestMismatchError extends Error
{
    private static readonly ErrorName = 'ChartDigestMismatchError'
    private static readonly Text = 'the pulled engine chart does not have the placement chart digest; nothing was installed'

    public constructor()
    {
        super(ChartDigestMismatchError.Text)
        this.name = ChartDigestMismatchError.ErrorName
    }
}

/**
 * Installs and upgrades the management engine in a hosted cluster with helm 3. The chart is pulled from
 * `oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine` at the placement's version into
 * `<state dir>/charts/<cluster>/` and refused unless helm reports the placement's ChartDigest; the local archive is what
 * is installed. The hive's one-time code goes into Secret `pragmatic-system/pragmatic-hive-enrolment-code` (key `code`,
 * `kubectl apply` on standard input, `WriteCode`) before the first `helm upgrade --install`: the code never appears on an
 * argument vector or in the chart values. Values: hosted=true, level=connected, tenant.id, console.host and
 * console.baseDomain (both the placement's HiveHostName: the sign-in service and the environments live under the hive's
 * own SNI label, nothing shared across hosted hives), console.address=relayed-hive-subdomain, tls.mode=self-signed. An
 * upgrade is helm only, `--atomic` (a failed one rolls back to the running release). Helm waits at most 15 minutes and
 * its process is killed at 35 (more than twice the wait: an --atomic rollback waits the same 15 minutes again).
 */
export class EngineInstaller
{
    public static readonly ChartReference = 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    public static readonly ReleaseName = 'pragmatic-engine'
    public static readonly Namespace = 'pragmatic-system'
    public static readonly CodeSecret = 'pragmatic-hive-enrolment-code'
    public static readonly CodeKey = 'code'
    public static readonly ChartsDir = 'charts'
    public static readonly HelmWait = '15m'
    /** More than twice HelmWait: a failed --atomic upgrade rolls back under the same wait, and helm must finish that. */
    public static readonly HelmProcessTimeoutMs = 35 * 60 * 1000
    public static readonly HelmWaitMs = 15 * 60 * 1000
    public static readonly PullTimeoutMs = 5 * 60 * 1000
    private static readonly Helm = 'helm'
    private static readonly Pull = 'pull'
    private static readonly Upgrade = 'upgrade'
    private static readonly InstallFlag = '--install'
    private static readonly AtomicFlag = '--atomic'
    private static readonly VersionFlag = '--version'
    private static readonly DestinationFlag = '--destination'
    private static readonly NamespaceFlag = '--namespace'
    private static readonly CreateNamespaceFlag = '--create-namespace'
    private static readonly KubeconfigFlag = '--kubeconfig'
    private static readonly WaitFlag = '--wait'
    private static readonly TimeoutFlag = '--timeout'
    private static readonly SetFlag = '--set'
    private static readonly SetStringFlag = '--set-string'
    private static readonly ChartPrefix = 'pragmatic-engine-'
    private static readonly ChartSuffix = '.tgz'
    private static readonly DigestLine = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m
    private static readonly Base64 = 'base64'
    private static readonly Assign = '='
    private static readonly Newline = '\n'
    private static readonly Hosted = 'hosted=true'
    private static readonly Level = 'level=connected'
    private static readonly TenantId = 'tenant.id'
    private static readonly ConsoleHost = 'console.host'
    private static readonly ConsoleBaseDomain = 'console.baseDomain'
    private static readonly ConsoleAddress = 'console.address=relayed-hive-subdomain'
    private static readonly TlsMode = 'tls.mode=self-signed'
    private static readonly ApiVersion = 'v1'
    private static readonly ListKind = 'List'
    private static readonly NamespaceKind = 'Namespace'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'
    private readonly run: CheckedRunner

    public constructor(runner: IProcessRunner, private readonly files: StateFiles, private readonly chartReference: string = EngineInstaller.ChartReference)
    {
        this.run = new CheckedRunner(runner)
    }

    /** The hive's one-time code into its Secret (applied: writing it again changes nothing). */
    public async WriteCode(kube: IHostedKube, enrolmentCode: string): Promise<void>
    {
        const E = EngineInstaller
        await kube.Apply({
            apiVersion: E.ApiVersion,
            kind: E.ListKind,
            items: [
                { apiVersion: E.ApiVersion, kind: E.NamespaceKind, metadata: { name: E.Namespace } },
                {
                    apiVersion: E.ApiVersion, kind: E.SecretKind, type: E.OpaqueType,
                    metadata: { name: E.CodeSecret, namespace: E.Namespace },
                    data: { [E.CodeKey]: Buffer.from(enrolmentCode).toString(E.Base64) },
                },
            ],
        })
    }

    /** The first install (after WriteCode): helm upgrade --install. */
    public Install(access: ClusterAccess, target: EngineTarget): Promise<void>
    {
        return this.Helm(access, target, false)
    }

    /** A new engine version or chart digest for an installed hive: helm upgrade --atomic only, never the code Secret. */
    public Upgrade(access: ClusterAccess, target: EngineTarget): Promise<void>
    {
        return this.Helm(access, target, true)
    }

    /** Drops the cluster's pulled charts (its removal). */
    public async Forget(clusterName: string): Promise<void>
    {
        await this.files.Remove(this.files.Path(EngineInstaller.ChartsDir, clusterName))
    }

    private async Helm(access: ClusterAccess, target: EngineTarget, atomic: boolean): Promise<void>
    {
        const E = EngineInstaller
        const chart = await this.PullChart(access, target)
        await this.run.Run(new ProcessCommand(E.Helm, [
            E.Upgrade, E.InstallFlag, E.ReleaseName, chart,
            E.NamespaceFlag, E.Namespace, E.CreateNamespaceFlag,
            E.KubeconfigFlag, access.KubeconfigPath,
            E.SetFlag, E.Hosted,
            E.SetStringFlag, E.Level,
            E.SetStringFlag, E.TenantId + E.Assign + target.Tenant,
            E.SetStringFlag, E.ConsoleHost + E.Assign + target.HiveHostName,
            E.SetStringFlag, E.ConsoleBaseDomain + E.Assign + target.HiveHostName,
            E.SetStringFlag, E.ConsoleAddress,
            E.SetStringFlag, E.TlsMode,
            ...(atomic ? [E.AtomicFlag] : []),
            E.WaitFlag, E.TimeoutFlag, E.HelmWait,
        ], undefined, E.HelmProcessTimeoutMs))
    }

    /** `helm pull` into a clean directory; the archive's path once helm reported the expected digest. */
    private async PullChart(access: ClusterAccess, target: EngineTarget): Promise<string>
    {
        const E = EngineInstaller
        const dir = this.files.Path(E.ChartsDir, access.Name)
        await this.files.Remove(dir)
        await this.files.EnsureDir(E.ChartsDir, access.Name)
        const result = await this.run.Run(new ProcessCommand(E.Helm, [E.Pull, this.chartReference, E.VersionFlag, target.EngineVersion, E.DestinationFlag, dir], undefined, E.PullTimeoutMs))
        const digest = E.DigestLine.exec(result.Stdout + E.Newline + result.Stderr)?.[1]
        if (digest !== target.ChartDigest)
        {
            await this.files.Remove(dir)
            throw new ChartDigestMismatchError()
        }
        return this.files.Path(E.ChartsDir, access.Name, E.ChartPrefix + target.EngineVersion + E.ChartSuffix)
    }
}
