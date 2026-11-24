import { readFile } from 'node:fs/promises'
import { HttpAgentChannel, SigningPublicKey, SystemProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { HostChannel } from './channel/host-channel.js'
import { FileEnrolmentCodeSource, HostEnrolment, HostEnrolmentFailure, HostEnrolmentRefusedError } from './enrolment/host-enrolment.js'
import { HostEnrolmentStore, type HostEnrolmentState } from './enrolment/host-enrolment-state.js'
import { HostAgentComponent } from './host-agent-component.js'
import { HostAgentLoop } from './host-agent-loop.js'
import { HostIdentity } from './identity/host-identity.js'
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

/** Waits between two enrolment attempts. */
export interface IDelay
{
    Wait(ms: number): Promise<void>
}

export class TimerDelay implements IDelay
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/**
 * The host agent (pragmatic-host-agentd): reads its settings, loads or creates the host key, enrols the machine once
 * (retrying while the platform is unreachable; a refused code stops the agent), then runs the capacity report loop.
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
        const loop = M.Wire(settings, channel, logger)
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

    private static Wire(settings: HostSettings, channel: HostChannel, logger: ILogger): HostAgentLoop
    {
        const store = new PlacementStore(new StateFiles(settings.StateDir))
        const reporter = new CapacityReporter(new DockerMachineProbe(new NodeProcessRunner(), settings.StateDir), store, settings.HiveSlots, HostAgentComponent.Version)
        return new HostAgentLoop(channel, reporter, logger)
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
