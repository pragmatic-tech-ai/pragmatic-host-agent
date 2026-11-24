import { ProtocolNames, SealingPublicKey, SigningPublicKey } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { StateFiles } from '../state/state-files.js'

/** What the machine is enrolled as: none of it is secret (the platform's public keys and the host id). */
export class HostEnrolmentState
{
    public constructor(
        public readonly HostId: string,
        public readonly SealingKey: SealingPublicKey,
        public readonly ChannelUrl: string,
        public readonly TrustRoot: SigningPublicKey)
    {
    }

    public get TrustRootKeyId(): string
    {
        return this.TrustRoot.KeyId
    }
}

/** The enrolment file is there but does not read as an enrolment (edited by hand?). */
export class HostEnrolmentStateUnreadableError extends Error
{
    private static readonly ErrorName = 'HostEnrolmentStateUnreadableError'
    private static readonly Text = 'the enrolment file enrolment.json in the state directory does not read as an enrolment'

    public constructor()
    {
        super(HostEnrolmentStateUnreadableError.Text)
        this.name = HostEnrolmentStateUnreadableError.ErrorName
    }
}

/**
 * The machine's enrolment, in `<state dir>/enrolment.json`: `hostId`, `channelUrl`, `sealingKey` (the platform's X25519
 * public key), `trustRootKeyId` and `trustRoot`. Written once, after the platform's answer verified; read at every
 * start, so an enrolled host never reads its code file again. The trust root read is always the pinned one: a stored
 * other one (a rotation of the pinned file, an edited state file) is replaced by it.
 */
export class HostEnrolmentStore
{
    public static readonly FileName = 'enrolment.json'
    private static readonly Key = { HostId: 'hostId', ChannelUrl: 'channelUrl', SealingKey: 'sealingKey', TrustRootKeyId: 'trustRootKeyId', TrustRoot: 'trustRoot' } as const

    public constructor(private readonly files: StateFiles, private readonly pinnedTrustRoot: SigningPublicKey)
    {
    }

    public async Read(): Promise<HostEnrolmentState | undefined>
    {
        const K = HostEnrolmentStore.Key
        let raw: unknown
        try
        {
            raw = await this.files.ReadJson(this.files.Path(HostEnrolmentStore.FileName))
        }
        catch
        {
            throw new HostEnrolmentStateUnreadableError()
        }
        if (raw === undefined)
        {
            return undefined
        }
        const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
        const hostId = data[K.HostId]
        const channelUrl = data[K.ChannelUrl]
        if (typeof hostId !== 'string' || !ProtocolNames.Label.test(hostId) || typeof channelUrl !== 'string' || !ProtocolNames.HttpsUrl.test(channelUrl))
        {
            throw new HostEnrolmentStateUnreadableError()
        }
        let sealing: SealingPublicKey
        let root: SigningPublicKey
        try
        {
            sealing = SealingPublicKey.Parse(data[K.SealingKey])
            root = SigningPublicKey.Parse(data[K.TrustRoot])
        }
        catch
        {
            throw new HostEnrolmentStateUnreadableError()
        }
        if (root.KeyId !== data[K.TrustRootKeyId])
        {
            throw new HostEnrolmentStateUnreadableError()
        }
        const state = new HostEnrolmentState(hostId, sealing, channelUrl, this.pinnedTrustRoot)
        if (!root.Equals(this.pinnedTrustRoot))
        {
            await this.Write(state)
        }
        return state
    }

    public async Write(state: HostEnrolmentState): Promise<void>
    {
        const K = HostEnrolmentStore.Key
        await this.files.WriteJson(this.files.Path(HostEnrolmentStore.FileName), {
            [K.HostId]: state.HostId,
            [K.ChannelUrl]: state.ChannelUrl,
            [K.SealingKey]: state.SealingKey.ToJson(),
            [K.TrustRootKeyId]: state.TrustRootKeyId,
            [K.TrustRoot]: state.TrustRoot.ToJson(),
        })
    }
}
