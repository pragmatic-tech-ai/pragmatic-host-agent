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
 * is installed. A first install writes the hive's one-time code into Secret `pragmatic-system/pragmatic-hive-enrolment-code`
 * (key `code`, through `kubectl apply` on standard input) before `helm upgrade --install`: the code never appears on an
 * argument vector or in the chart values. Values: hosted=true, level=connected, tenant.id, console.host (the placement's
 * HiveHostName), console.address=relayed-hive-subdomain, tls.mode=self-signed. An upgrade is helm only.
 */
export class EngineInstaller
{
    public static readonly ChartReference = 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    public static readonly ReleaseName = 'pragmatic-engine'
    public static readonly Namespace = 'pragmatic-system'
    public static readonly CodeSecret = 'pragmatic-hive-enrolment-code'
    public static readonly CodeKey = 'code'
    public static readonly ChartsDir = 'charts'
    private static readonly Helm = 'helm'
    private static readonly ChartPrefix = 'pragmatic-engine-'
    private static readonly ChartSuffix = '.tgz'
    private static readonly DigestLine = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m
    private static readonly Timeout = '15m'
    private static readonly Base64 = 'base64'
    private static readonly SetFlag = '--set'
    private static readonly SetStringFlag = '--set-string'
    private static readonly Assign = '='
    private static readonly Hosted = 'hosted=true'
    private static readonly Level = 'level=connected'
    private static readonly TenantId = 'tenant.id'
    private static readonly ConsoleHost = 'console.host'
    private static readonly ConsoleAddress = 'console.address=relayed-hive-subdomain'
    private static readonly TlsMode = 'tls.mode=self-signed'
    private readonly run: CheckedRunner

    public constructor(runner: IProcessRunner, private readonly files: StateFiles, private readonly chartReference: string = EngineInstaller.ChartReference)
    {
        this.run = new CheckedRunner(runner)
    }

    /** The first install: the code Secret, then the chart. */
    public async Install(access: ClusterAccess, kube: IHostedKube, target: EngineTarget, enrolmentCode: string): Promise<void>
    {
        const E = EngineInstaller
        await kube.Apply({
            apiVersion: 'v1',
            kind: 'List',
            items: [
                { apiVersion: 'v1', kind: 'Namespace', metadata: { name: E.Namespace } },
                {
                    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
                    metadata: { name: E.CodeSecret, namespace: E.Namespace },
                    data: { [E.CodeKey]: Buffer.from(enrolmentCode).toString(E.Base64) },
                },
            ],
        })
        await this.Helm(access, target)
    }

    /** A new engine version or chart digest for an installed hive: helm upgrade only. */
    public Upgrade(access: ClusterAccess, target: EngineTarget): Promise<void>
    {
        return this.Helm(access, target)
    }

    private async Helm(access: ClusterAccess, target: EngineTarget): Promise<void>
    {
        const E = EngineInstaller
        const chart = await this.Pull(access, target)
        await this.run.Run(new ProcessCommand(E.Helm, [
            'upgrade', '--install', E.ReleaseName, chart,
            '--namespace', E.Namespace, '--create-namespace',
            '--kubeconfig', access.KubeconfigPath,
            E.SetFlag, E.Hosted,
            E.SetStringFlag, E.Level,
            E.SetStringFlag, E.TenantId + E.Assign + target.Tenant,
            E.SetStringFlag, E.ConsoleHost + E.Assign + target.HiveHostName,
            E.SetStringFlag, E.ConsoleAddress,
            E.SetStringFlag, E.TlsMode,
            '--wait', '--timeout', E.Timeout,
        ]))
    }

    /** `helm pull` into a clean directory; the archive's path once helm reported the expected digest. */
    private async Pull(access: ClusterAccess, target: EngineTarget): Promise<string>
    {
        const E = EngineInstaller
        const dir = this.files.Path(E.ChartsDir, access.Name)
        await this.files.Remove(dir)
        await this.files.EnsureDir(E.ChartsDir, access.Name)
        const result = await this.run.Run(new ProcessCommand(E.Helm, ['pull', this.chartReference, '--version', target.EngineVersion, '--destination', dir]))
        const digest = E.DigestLine.exec(result.Stdout + '\n' + result.Stderr)?.[1]
        if (digest !== target.ChartDigest)
        {
            await this.files.Remove(dir)
            throw new ChartDigestMismatchError()
        }
        return this.files.Path(E.ChartsDir, access.Name, E.ChartPrefix + target.EngineVersion + E.ChartSuffix)
    }
}
