import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpAgentChannel, SigningPublicKey, SystemProtocolClock, type IProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { HostChannel } from './channel/host-channel.js'
import { KindClusterDriver } from './cluster/kind-cluster-driver.js'
import { PortAllocator } from './cluster/port-allocator.js'
import { ClusterCredentialIssuer } from './credential/cluster-credential-issuer.js'
import { FileEnrolmentCodeSource, HostEnrolment, HostEnrolmentFailure, HostEnrolmentRefusedError } from './enrolment/host-enrolment.js'
import { HostEnrolmentStore, type HostEnrolmentState } from './enrolment/host-enrolment-state.js'
import { EngineInstaller } from './engine/engine-installer.js'
import { HostAgentComponent } from './host-agent-component.js'
import { HostAgentLoop } from './host-agent-loop.js'
import { HostIdentity } from './identity/host-identity.js'
import { KubectlHostedKubeFactory } from './kube/hosted-kube.js'
import { PlacementPuller } from './placement/placement-puller.js'
import { PlacementReconciler, TimerDelay, type IDelay } from './placement/placement-reconciler.js'
import { PlacementStore } from './placement/placement-store.js'
import { NodeProcessRunner } from './process/process-runner.js'
import { CapacityReporter } from './report/capacity-reporter.js'
import { DockerMachineProbe } from './report/machine-probe.js'
import { HostSettings } from './settings/host-settings.js'
import { StateFiles } from './state/state-files.js'

/** The trust root file does not hold an Ed25519 public key (SPKI PEM). */
export class TrustRootUnreadableError extends Error
{
    private static readonly ErrorName = 'TrustRootUnreadableError'
    private static readonly Text = 'PRAGMATIC_HOST_TRUST_ROOT_FILE does not hold the platform signing key (an Ed25519 SPKI PEM)'

    public constructor()
    {
        super(TrustRootUnreadableError.Text)
        this.name = TrustRootUnreadableError.ErrorName
    }
}

/**
 * The host agent (pragmatic-host-agentd): reads its settings, loads or creates the host key, enrols the machine once
 * (retrying while the platform is unreachable; a refused code stops the agent), then runs the report and placement
 * loops (HostAgentLoop) with the kind driver, helm and kubectl from its image.
 */
export class HostAgentMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly EnrolRetryMs = 30_000
    private static readonly StartFailedPrefix = 'pragmatic-host-agentd failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly EventKey = 'event'
    private static readonly HostKey = 'hostId'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly EnrolRetryLine = 'host enrolment unavailable: retrying'
    private static readonly EnrolRetryEvent = 'enrol-retry'
    private static readonly StartedLine = 'pragmatic-host-agentd started'
    private static readonly StartedEvent = 'startup'
    private static readonly VendorDir = 'vendor'

    private constructor()
    {
    }

    public static async Run(env: NodeJS.ProcessEnv = process.env): Promise<HostAgentLoop>
    {
        const M = HostAgentMain
        const settings = HostSettings.FromEnv(env)
        const logger = StructuredLogger.ToStdout()
        const clock = new SystemProtocolClock()
        const files = new StateFiles(settings.StateDir)
        await files.EnsureDir()
        const trustRoot = await M.TrustRoot(settings.TrustRootFile)
        const key = await HostIdentity.LoadOrCreate(files)
        const enrolment = new HostEnrolment({
            Key: key, Channel: new HttpAgentChannel(settings.ChannelUrl), Store: new HostEnrolmentStore(files, trustRoot), PinnedTrustRoot: trustRoot,
            MachineName: settings.MachineName, MeshAddress: settings.MeshAddress, AgentVersion: HostAgentComponent.Version, Clock: clock,
        })
        const state = await M.Enrol(enrolment, new FileEnrolmentCodeSource(settings.EnrolmentCodeFile), logger, new TimerDelay())
        const channel = new HostChannel(key, state, new HttpAgentChannel(state.ChannelUrl), clock)
        const loop = M.Wire(settings, files, state, channel, clock, logger)
        logger.Info(M.StartedLine, { [M.EventKey]: M.StartedEvent, [M.HostKey]: state.HostId })
        loop.Start()
        return loop
    }

    /** The enrolment, retried while the platform is unavailable; any other refusal stops the start. */
    public static async Enrol(enrolment: HostEnrolment, codes: FileEnrolmentCodeSource, logger: ILogger, delay: IDelay): Promise<HostEnrolmentState>
    {
        const M = HostAgentMain
        for (;;)
        {
            try
            {
                return await enrolment.EnsureEnrolled(codes)
            }
            catch (error)
            {
                if (!(error instanceof HostEnrolmentRefusedError) || error.Failure !== HostEnrolmentFailure.Unavailable)
                {
                    throw error
                }
                logger.Warn(M.EnrolRetryLine, { [M.EventKey]: M.EnrolRetryEvent })
                await delay.Wait(M.EnrolRetryMs)
            }
        }
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(HostAgentMain.StartFailedPrefix + (error instanceof Error ? error.message : HostAgentMain.UnknownError), { [HostAgentMain.EventKey]: HostAgentMain.StartFailedEvent })
        process.exit(1)
    }

    /** The vendored ingress-nginx manifest beside the compiled code (`<app>/vendor/...`, `<app>/dist/host-agent-main.js`). */
    public static IngressManifestPath(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', ...KindClusterDriver.IngressManifest.split('/'))
    }

    private static Wire(settings: HostSettings, files: StateFiles, state: HostEnrolmentState, channel: HostChannel, clock: IProtocolClock, logger: ILogger): HostAgentLoop
    {
        const runner = new NodeProcessRunner()
        const store = new PlacementStore(files)
        const reconciler = new PlacementReconciler({
            Store: store,
            Driver: new KindClusterDriver(runner, files, HostAgentMain.IngressManifestPath()),
            Ports: new PortAllocator(settings.Ports),
            Engine: new EngineInstaller(runner, files),
            Kube: new KubectlHostedKubeFactory(runner),
            Credentials: new ClusterCredentialIssuer(clock),
            Channel: channel,
            SealingKey: state.SealingKey,
            MeshAddress: settings.MeshAddress,
            HiveSlots: settings.HiveSlots,
            Clock: clock,
            Logger: logger,
        })
        const reporter = new CapacityReporter(new DockerMachineProbe(runner, settings.StateDir), store, settings.HiveSlots, HostAgentComponent.Version)
        return new HostAgentLoop(channel, reporter, new PlacementPuller(channel, store, reconciler, logger), reconciler, logger)
    }

    private static async TrustRoot(path: string): Promise<SigningPublicKey>
    {
        try
        {
            return SigningPublicKey.FromPem(await readFile(path, HostAgentMain.Utf8))
        }
        catch
        {
            throw new TrustRootUnreadableError()
        }
    }
}
