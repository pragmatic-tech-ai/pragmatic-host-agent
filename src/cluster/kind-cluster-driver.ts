import { ClusterKind } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { CheckedRunner, ProcessCommand, type IProcessRunner } from '../process/process-runner.js'
import type { StateFiles } from '../state/state-files.js'
import { ClusterAccess, type ClusterSpec, type IClusterDriver } from './cluster-driver.js'
import { KindClusterConfig } from './kind-cluster-config.js'

/**
 * IClusterDriver over the `kind` CLI (and `kubectl` for the add-ons), every call an argument vector with a deadline. A
 * cluster's files sit in `<state dir>/clusters/<name>/`: `kind-config.yaml` (KindClusterConfig) and `kubeconfig` (the
 * admin access kind writes, server 127.0.0.1:<port>; never handed over). Create: `kind create cluster` (when
 * `kind get clusters` does not list it yet, else `kind export kubeconfig`), then ingress-nginx from the manifest
 * vendored in the image (`vendor/ingress-nginx/deploy.yaml`, controller v1.15.1, images by digest), its IngressClass made
 * the default, and its controller waited for. kind's own default StorageClass (`standard`, local-path) is kept.
 */
export class KindClusterDriver implements IClusterDriver
{
    public readonly Kind = ClusterKind.Kind
    public static readonly ClustersDir = 'clusters'
    public static readonly ConfigFile = 'kind-config.yaml'
    public static readonly KubeconfigFile = 'kubeconfig'
    public static readonly IngressManifest = 'vendor/ingress-nginx/deploy.yaml'
    /** kind waits up to 5 minutes for the control plane; its process is killed at 15. */
    public static readonly CreateTimeoutMs = 15 * 60 * 1000
    /** The ingress rollout waits up to 300 s; its process is killed at 10 minutes. */
    public static readonly RolloutTimeoutMs = 10 * 60 * 1000
    public static readonly ShortTimeoutMs = 2 * 60 * 1000
    private static readonly KindProgram = 'kind'
    private static readonly Kubectl = 'kubectl'
    private static readonly Create = 'create'
    private static readonly Delete = 'delete'
    private static readonly Get = 'get'
    private static readonly Export = 'export'
    private static readonly Cluster = 'cluster'
    private static readonly Clusters = 'clusters'
    private static readonly KubeconfigVerb = 'kubeconfig'
    private static readonly Apply = 'apply'
    private static readonly Annotate = 'annotate'
    private static readonly Rollout = 'rollout'
    private static readonly Status = 'status'
    private static readonly NameFlag = '--name'
    private static readonly ConfigFlag = '--config'
    private static readonly KubeconfigFlag = '--kubeconfig'
    private static readonly WaitFlag = '--wait'
    private static readonly FileFlag = '-f'
    private static readonly OverwriteFlag = '--overwrite'
    private static readonly NamespaceFlag = '--namespace'
    private static readonly Newline = /\r?\n/
    private static readonly Wait = '5m'
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressDeployment = 'deployment/ingress-nginx-controller'
    private static readonly IngressClass = 'ingressclass/nginx'
    private static readonly DefaultClassAnnotation = 'ingressclass.kubernetes.io/is-default-class=true'
    private static readonly RolloutTimeout = '--timeout=300s'
    private readonly run: CheckedRunner

    /** `ingressManifest`: the vendored manifest's absolute path (in the image: /workspace/pragmatic-host-agent/vendor/...). */
    public constructor(runner: IProcessRunner, private readonly files: StateFiles, private readonly ingressManifest: string, private readonly config: KindClusterConfig = new KindClusterConfig())
    {
        this.run = new CheckedRunner(runner)
    }

    public async Create(spec: ClusterSpec): Promise<ClusterAccess>
    {
        const D = KindClusterDriver
        await this.files.EnsureDir(D.ClustersDir, spec.Name)
        const configPath = this.files.Path(D.ClustersDir, spec.Name, D.ConfigFile)
        const kubeconfig = this.KubeconfigOf(spec.Name)
        if (await this.Exists(spec.Name))
        {
            await this.ExportKubeconfig(spec.Name, kubeconfig)
        }
        else
        {
            await this.files.WriteText(configPath, this.config.Render(spec))
            await this.run.Run(new ProcessCommand(D.KindProgram,
                [D.Create, D.Cluster, D.NameFlag, spec.Name, D.ConfigFlag, configPath, D.KubeconfigFlag, kubeconfig, D.WaitFlag, D.Wait], undefined, D.CreateTimeoutMs))
        }
        await this.run.Run(new ProcessCommand(D.Kubectl, [D.KubeconfigFlag, kubeconfig, D.Apply, D.FileFlag, this.ingressManifest], undefined, D.ShortTimeoutMs))
        await this.run.Run(new ProcessCommand(D.Kubectl, [D.KubeconfigFlag, kubeconfig, D.Annotate, D.OverwriteFlag, D.IngressClass, D.DefaultClassAnnotation], undefined, D.ShortTimeoutMs))
        await this.run.Run(new ProcessCommand(D.Kubectl,
            [D.KubeconfigFlag, kubeconfig, D.NamespaceFlag, D.IngressNamespace, D.Rollout, D.Status, D.IngressDeployment, D.RolloutTimeout], undefined, D.RolloutTimeoutMs))
        return new ClusterAccess(spec.Name, kubeconfig)
    }

    public async Access(name: string): Promise<ClusterAccess>
    {
        await this.files.EnsureDir(KindClusterDriver.ClustersDir, name)
        const kubeconfig = this.KubeconfigOf(name)
        await this.ExportKubeconfig(name, kubeconfig)
        return new ClusterAccess(name, kubeconfig)
    }

    public async Delete(name: string): Promise<void>
    {
        const D = KindClusterDriver
        // kind deletes a cluster that does not exist without complaint.
        await this.run.Run(new ProcessCommand(D.KindProgram, [D.Delete, D.Cluster, D.NameFlag, name], undefined, D.CreateTimeoutMs))
        await this.files.Remove(this.files.Path(D.ClustersDir, name))
    }

    public async Exists(name: string): Promise<boolean>
    {
        const D = KindClusterDriver
        const result = await this.run.Run(new ProcessCommand(D.KindProgram, [D.Get, D.Clusters], undefined, D.ShortTimeoutMs))
        return result.Stdout.split(D.Newline).some(line => line.trim() === name)
    }

    private async ExportKubeconfig(name: string, kubeconfig: string): Promise<void>
    {
        const D = KindClusterDriver
        await this.run.Run(new ProcessCommand(D.KindProgram, [D.Export, D.KubeconfigVerb, D.NameFlag, name, D.KubeconfigFlag, kubeconfig], undefined, D.ShortTimeoutMs))
    }

    private KubeconfigOf(name: string): string
    {
        return this.files.Path(KindClusterDriver.ClustersDir, name, KindClusterDriver.KubeconfigFile)
    }
}
