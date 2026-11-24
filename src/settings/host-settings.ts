import { ProtocolNames } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HostAgentComponent } from '../host-agent-component.js'

/** The first and last API-server port the host hands its clusters (inclusive). */
export class PortRange
{
    private static readonly Pattern = /^(\d{1,5})-(\d{1,5})$/
    private static readonly MaxPort = 65535

    public constructor(public readonly First: number, public readonly Last: number)
    {
    }

    /** `first-last`, both 1-65535, first <= last; undefined otherwise. */
    public static Parse(text: string): PortRange | undefined
    {
        const match = PortRange.Pattern.exec(text)
        if (match === null)
        {
            return undefined
        }
        const first = Number(match[1])
        const last = Number(match[2])
        if (first < 1 || last > PortRange.MaxPort || first > last)
        {
            return undefined
        }
        return new PortRange(first, last)
    }

    public get Size(): number
    {
        return this.Last - this.First + 1
    }

    public Ports(): number[]
    {
        const ports: number[] = []
        for (let port = this.First; port <= this.Last; port += 1)
        {
            ports.push(port)
        }
        return ports
    }
}

/** The host agent cannot start: the message names every setting that is missing or wrong (never a value). */
export class HostSettingsError extends Error
{
    private static readonly ErrorName = 'HostSettingsError'
    /** The start-smoke refusal pattern (the release toolkit's host agent profile) matches this prefix. */
    public static readonly Prefix = 'the host agent is not configured: '
    private static readonly Separator = '; '

    public constructor(public readonly Problems: readonly string[])
    {
        super(HostSettingsError.Prefix + Problems.join(HostSettingsError.Separator))
        this.name = HostSettingsError.ErrorName
    }
}

/**
 * What the host agent runs with, from the environment its container is started with (HostAgentComponent's settings):
 * the state directory, the channel, the machine's name and mesh address, its hive slots and API-server port range, the
 * one-time enrolment code's file (read once, before enrolment) and the pinned trust root's file.
 */
export class HostSettings
{
    private static readonly Missing = ' must be set'
    private static readonly MustNameMachine = ' must be a DNS label (lowercase letters, digits, hyphens)'
    private static readonly MustNameAddress = ' must be an IP address or host name'
    private static readonly MustBeHttps = ' must be an https URL'
    private static readonly MustBeSlots = ' must be an integer from 1 to 64'
    private static readonly MustBeRange = ' must be <first>-<last> (ports 1-65535)'
    private static readonly MustBeAbsolute = ' must be an absolute path'
    private static readonly SlotsTooMany = ' must not exceed the number of ports in PRAGMATIC_HOST_PORT_RANGE'
    private static readonly MaxSlots = 64
    private static readonly Slash = '/'

    private constructor(
        public readonly StateDir: string,
        public readonly ChannelUrl: string,
        public readonly MachineName: string,
        public readonly MeshAddress: string,
        public readonly HiveSlots: number,
        public readonly Ports: PortRange,
        public readonly EnrolmentCodeFile: string | undefined,
        public readonly TrustRootFile: string)
    {
    }

    public static FromEnv(env: NodeJS.ProcessEnv): HostSettings
    {
        const S = HostSettings
        const V = HostAgentComponent.Env
        const D = HostAgentComponent.Defaults
        const problems: string[] = []
        const stateDir = S.Text(env, V.StateDir) ?? D.StateDir
        if (!stateDir.startsWith(S.Slash))
        {
            problems.push(V.StateDir + S.MustBeAbsolute)
        }
        const channelUrl = S.Text(env, V.ChannelUrl) ?? D.ChannelUrl
        if (!ProtocolNames.HttpsUrl.test(channelUrl))
        {
            problems.push(V.ChannelUrl + S.MustBeHttps)
        }
        const machine = S.Text(env, V.MachineName)
        if (machine === undefined)
        {
            problems.push(V.MachineName + S.Missing)
        }
        else if (!ProtocolNames.Label.test(machine))
        {
            problems.push(V.MachineName + S.MustNameMachine)
        }
        const mesh = S.Text(env, V.MeshAddress)
        if (mesh === undefined)
        {
            problems.push(V.MeshAddress + S.Missing)
        }
        else if (!ProtocolNames.IsAddress(mesh))
        {
            problems.push(V.MeshAddress + S.MustNameAddress)
        }
        const slotsText = S.Text(env, V.HiveSlots) ?? String(D.HiveSlots)
        const slots = /^\d{1,2}$/.test(slotsText) ? Number(slotsText) : NaN
        if (!(slots >= 1 && slots <= S.MaxSlots))
        {
            problems.push(V.HiveSlots + S.MustBeSlots)
        }
        const ports = PortRange.Parse(S.Text(env, V.PortRange) ?? D.PortRange)
        if (ports === undefined)
        {
            problems.push(V.PortRange + S.MustBeRange)
        }
        else if (slots > ports.Size)
        {
            problems.push(V.HiveSlots + S.SlotsTooMany)
        }
        const codeFile = S.Text(env, V.EnrolmentCodeFile)
        if (codeFile !== undefined && !codeFile.startsWith(S.Slash))
        {
            problems.push(V.EnrolmentCodeFile + S.MustBeAbsolute)
        }
        const trustRootFile = S.Text(env, V.TrustRootFile)
        if (trustRootFile === undefined)
        {
            problems.push(V.TrustRootFile + S.Missing)
        }
        else if (!trustRootFile.startsWith(S.Slash))
        {
            problems.push(V.TrustRootFile + S.MustBeAbsolute)
        }
        if (problems.length > 0)
        {
            throw new HostSettingsError(problems)
        }
        return new HostSettings(stateDir, channelUrl, machine as string, mesh as string, slots, ports as PortRange, codeFile, trustRootFile as string)
    }

    private static Text(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim()
        return value === undefined || value.length === 0 ? undefined : value
    }
}
