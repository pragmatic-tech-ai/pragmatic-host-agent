import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/** The environment variables the host agent reads (HostSettings). */
class HostAgentEnv
{
    public readonly StateDir = 'PRAGMATIC_HOST_STATE_DIR'
    public readonly ChannelUrl = 'PRAGMATIC_HOST_CHANNEL_URL'
    public readonly MachineName = 'PRAGMATIC_HOST_MACHINE_NAME'
    public readonly MeshAddress = 'PRAGMATIC_HOST_MESH_ADDRESS'
    public readonly HiveSlots = 'PRAGMATIC_HOST_HIVE_SLOTS'
    public readonly PortRange = 'PRAGMATIC_HOST_PORT_RANGE'
    public readonly EnrolmentCodeFile = 'PRAGMATIC_HOST_ENROLMENT_CODE_FILE'
    public readonly TrustRootFile = 'PRAGMATIC_HOST_TRUST_ROOT_FILE'
}

/** The settings' defaults. */
class HostAgentDefaults
{
    public readonly StateDir = '/var/lib/pragmatic-host-agent'
    public readonly ChannelUrl = 'https://agent.pragmatic-tech.ai'
    public readonly HiveSlots = 4
    public readonly PortRange = '16444-16463'
}

/**
 * The component descriptor of the host agent image (pragmatic-host-agentd, C5.1): the agent on one of our hosting
 * machines that enrols the machine once, reports its capacity, pulls placements and creates, installs, hands over and
 * removes the Hosted hives' clusters. It runs on the machine (host networking, the Docker socket and its state directory
 * mounted), not in a hive, so no tenant configuration ever reaches it; it listens on no port and stores its own key,
 * enrolment and placements in the state directory (never a platform secret).
 */
export class HostAgentComponent
{
    public static readonly Name = 'pragmatic-host-agent'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.5'
    public static readonly Env = new HostAgentEnv()
    public static readonly Defaults = new HostAgentDefaults()

    /** The declaration: the descriptor, and the variable each setting is read from. */
    public static readonly Declaration: ComponentDeclaration = {
        name: HostAgentComponent.Name,
        version: HostAgentComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The host agent of one hosting machine.',
                settings: [
                    { name: 'stateDir', type: SettingType.String, source: HostAgentComponent.Env.StateDir, default: HostAgentComponent.Defaults.StateDir, description: 'The directory the host key (mode 0600), the enrolment and the placements are kept in.' },
                    { name: 'channelUrl', type: SettingType.Url, source: HostAgentComponent.Env.ChannelUrl, default: HostAgentComponent.Defaults.ChannelUrl, description: 'The platform agent channel the host enrols over (the enrolment answer names the one used after).' },
                    { name: 'machineName', type: SettingType.String, source: HostAgentComponent.Env.MachineName, required: true, description: 'The machine name the host enrols with (a DNS label).' },
                    { name: 'meshAddress', type: SettingType.String, source: HostAgentComponent.Env.MeshAddress, required: true, description: 'The machine mesh address the platform reaches the hosted clusters API servers at.' },
                    { name: 'hiveSlots', type: SettingType.Integer, source: HostAgentComponent.Env.HiveSlots, default: HostAgentComponent.Defaults.HiveSlots, minimum: 1, maximum: 64, description: 'How many Hosted hives the machine holds at most.' },
                    { name: 'portRange', type: SettingType.String, source: HostAgentComponent.Env.PortRange, default: HostAgentComponent.Defaults.PortRange, description: 'The API-server ports the clusters bind on 127.0.0.1, <first>-<last>.' },
                    { name: 'enrolmentCode', type: SettingType.String, source: HostAgentComponent.Env.EnrolmentCodeFile, secret: true, description: 'The one-time host enrolment code from the platform admin console (read once, before enrolment).' },
                    { name: 'trustRootFile', type: SettingType.String, source: HostAgentComponent.Env.TrustRootFile, required: true, description: 'The pinned platform signing key (public, PEM) the enrolment answer must be signed by.' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        ports: [],
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(HostAgentComponent.Declaration)
    }
}
