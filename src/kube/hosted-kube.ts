import { CheckedRunner, ProcessCommand, ProcessFailedError, type IProcessRunner } from '../process/process-runner.js'
import type { ClusterAccess } from '../cluster/cluster-driver.js'

/** A cluster's own kubeconfig as `kubectl config view --raw -o json` prints it (the parts the host agent reads). */
export interface RawKubeconfig
{
    clusters?: { name?: string; cluster?: { server?: string; 'certificate-authority-data'?: string } }[]
}

/** The answer of `kubectl config view` is not a kubeconfig with one cluster and its CA. */
export class KubeconfigUnreadableError extends Error
{
    private static readonly ErrorName = 'KubeconfigUnreadableError'
    private static readonly Text = 'the cluster kubeconfig names no cluster with its certificate authority'

    public constructor()
    {
        super(KubeconfigUnreadableError.Text)
        this.name = KubeconfigUnreadableError.ErrorName
    }
}

/** What the host agent does inside a hosted cluster through `kubectl` (IHostedKube; faked in tests). */
export interface IHostedKube
{
    /** `kubectl apply -f -` with the manifest on standard input (a Secret's data never reaches the argument vector). */
    Apply(manifest: unknown): Promise<void>
    ConfigMapExists(namespace: string, name: string): Promise<boolean>
    /** A TokenRequest for the service account (`kubectl create token`), valid `durationHours`; the token is never logged. */
    CreateToken(namespace: string, serviceAccount: string, durationHours: number): Promise<string>
    /** The cluster's certificate authority (base64 PEM, as kubeconfig carries it). */
    CertificateAuthority(): Promise<string>
}

/** Makes the IHostedKube of a cluster the host agent created. */
export interface IHostedKubeFactory
{
    For(access: ClusterAccess): IHostedKube
}

/** IHostedKube over the kubectl CLI with the cluster's admin kubeconfig, argument vectors only. */
export class KubectlHostedKube implements IHostedKube
{
    private static readonly Kubectl = 'kubectl'
    private static readonly Kubeconfig = '--kubeconfig'
    private static readonly NotFound = /\(NotFound\)|NotFound/
    private static readonly HoursSuffix = 'h'
    private static readonly TimeoutMs = 2 * 60 * 1000
    private static readonly Apply = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly StdinFile = '-'
    private static readonly Get = 'get'
    private static readonly ConfigMap = 'configmap'
    private static readonly NamespaceFlag = '--namespace'
    private static readonly OutputFlag = '-o'
    private static readonly NameOutput = 'name'
    private static readonly JsonOutput = 'json'
    private static readonly Create = 'create'
    private static readonly Token = 'token'
    private static readonly DurationFlag = '--duration'
    private static readonly Config = 'config'
    private static readonly View = 'view'
    private static readonly RawFlag = '--raw'
    private static readonly CaKey = 'certificate-authority-data'
    private readonly run: CheckedRunner

    public constructor(private readonly runner: IProcessRunner, private readonly access: ClusterAccess)
    {
        this.run = new CheckedRunner(runner)
    }

    public async Apply(manifest: unknown): Promise<void>
    {
        const K = KubectlHostedKube
        await this.run.Run(this.Command([K.Apply, K.FileFlag, K.StdinFile], Buffer.from(JSON.stringify(manifest))))
    }

    public async ConfigMapExists(namespace: string, name: string): Promise<boolean>
    {
        const K = KubectlHostedKube
        const command = this.Command([K.Get, K.ConfigMap, name, K.NamespaceFlag, namespace, K.OutputFlag, K.NameOutput])
        const result = await this.runner.Run(command)
        if (result.Succeeded)
        {
            return true
        }
        if (KubectlHostedKube.NotFound.test(result.Stderr))
        {
            return false
        }
        throw new ProcessFailedError(command.Program, result.ExitCode, result.Stderr)
    }

    public async CreateToken(namespace: string, serviceAccount: string, durationHours: number): Promise<string>
    {
        const K = KubectlHostedKube
        const result = await this.run.Run(this.Command([K.Create, K.Token, serviceAccount, K.NamespaceFlag, namespace, K.DurationFlag, String(durationHours) + K.HoursSuffix]))
        return result.Stdout.trim()
    }

    public async CertificateAuthority(): Promise<string>
    {
        const K = KubectlHostedKube
        const result = await this.run.Run(this.Command([K.Config, K.View, K.RawFlag, K.OutputFlag, K.JsonOutput]))
        let raw: RawKubeconfig
        try
        {
            raw = JSON.parse(result.Stdout) as RawKubeconfig
        }
        catch
        {
            throw new KubeconfigUnreadableError()
        }
        const ca = raw.clusters?.length === 1 ? raw.clusters[0].cluster?.[K.CaKey] : undefined
        if (typeof ca !== 'string' || ca.length === 0)
        {
            throw new KubeconfigUnreadableError()
        }
        return ca
    }

    private Command(args: readonly string[], stdin?: Buffer): ProcessCommand
    {
        return new ProcessCommand(KubectlHostedKube.Kubectl, [KubectlHostedKube.Kubeconfig, this.access.KubeconfigPath, ...args], stdin, KubectlHostedKube.TimeoutMs)
    }
}

export class KubectlHostedKubeFactory implements IHostedKubeFactory
{
    public constructor(private readonly runner: IProcessRunner)
    {
    }

    public For(access: ClusterAccess): IHostedKube
    {
        return new KubectlHostedKube(this.runner, access)
    }
}
