import { ClusterKind } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { CheckedRunner, ProcessCommand, type IProcessRunner } from '../process/process-runner.js'
import type { StateFiles } from '../state/state-files.js'
import { ClusterAccess, type ClusterSpec, type IClusterDriver } from './cluster-driver.js'
import { KindClusterConfig } from './kind-cluster-config.js'

/**
 * IClusterDriver over the `kind` CLI (and `kubectl` for the add-ons), every call an argument vector. A cluster's files
 * sit in `<state dir>/clusters/<name>/`: `kind-config.yaml` (KindClusterConfig) and `kubeconfig` (the admin access kind
 * writes, server 127.0.0.1:<port>; never handed over). Create: `kind create cluster` (when `kind get clusters` does not
 * list it yet, else `kind export kubeconfig`), then ingress-nginx from the manifest vendored in the image
 * (`vendor/ingress-nginx/deploy.yaml`, controller v1.15.1, images by digest), its IngressClass made the default, and
 * its controller waited for. kind's own default StorageClass (`standard`, local-path) is kept.
 */
export class KindClusterDriver implements IClusterDriver
{
    public readonly Kind = ClusterKind.Kind
    public static readonly ClustersDir = 'clusters'
    public static readonly ConfigFile = 'kind-config.yaml'
    public static readonly KubeconfigFile = 'kubeconfig'
    public static readonly IngressManifest = 'vendor/ingress-nginx/deploy.yaml'
    private static readonly Kind = 'kind'
    private static readonly Kubectl = 'kubectl'
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
        const kubeconfig = this.files.Path(D.ClustersDir, spec.Name, D.KubeconfigFile)
        if (await this.Exists(spec.Name))
        {
            await this.run.Run(new ProcessCommand(D.Kind, ['export', 'kubeconfig', '--name', spec.Name, '--kubeconfig', kubeconfig]))
        }
        else
        {
            await this.files.WriteText(configPath, this.config.Render(spec))
            await this.run.Run(new ProcessCommand(D.Kind, ['create', 'cluster', '--name', spec.Name, '--config', configPath, '--kubeconfig', kubeconfig, '--wait', D.Wait]))
        }
        await this.run.Run(new ProcessCommand(D.Kubectl, ['--kubeconfig', kubeconfig, 'apply', '-f', this.ingressManifest]))
        await this.run.Run(new ProcessCommand(D.Kubectl, ['--kubeconfig', kubeconfig, 'annotate', '--overwrite', D.IngressClass, D.DefaultClassAnnotation]))
        await this.run.Run(new ProcessCommand(D.Kubectl, ['--kubeconfig', kubeconfig, '--namespace', D.IngressNamespace, 'rollout', 'status', D.IngressDeployment, D.RolloutTimeout]))
        return new ClusterAccess(spec.Name, kubeconfig)
    }

    public async Access(name: string): Promise<ClusterAccess>
    {
        const D = KindClusterDriver
        await this.files.EnsureDir(D.ClustersDir, name)
        const kubeconfig = this.files.Path(D.ClustersDir, name, D.KubeconfigFile)
        await this.run.Run(new ProcessCommand(D.Kind, ['export', 'kubeconfig', '--name', name, '--kubeconfig', kubeconfig]))
        return new ClusterAccess(name, kubeconfig)
    }

    public async Delete(name: string): Promise<void>
    {
        const D = KindClusterDriver
        // kind deletes a cluster that does not exist without complaint.
        await this.run.Run(new ProcessCommand(D.Kind, ['delete', 'cluster', '--name', name]))
        await this.files.Remove(this.files.Path(D.ClustersDir, name))
    }

    public async Exists(name: string): Promise<boolean>
    {
        const result = await this.run.Run(new ProcessCommand(KindClusterDriver.Kind, ['get', 'clusters']))
        return result.Stdout.split(KindClusterDriver.Newline).some(line => line.trim() === name)
    }
}
