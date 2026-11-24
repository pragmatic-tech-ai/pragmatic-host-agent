import {
    EnvelopeSigner, EnvelopeVerifier, InMemoryNonceLedger, KeyDirectory, MessageKind, Participant, PlacementRequest, Pull, PullBatch, SystemProtocolClock,
    type IAgentChannel, type IMessageBody, type IProtocolClock, type SignedEnvelope, type SigningKeyPair, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HostEnrolmentState } from '../enrolment/host-enrolment-state.js'

/** The platform answered a message that takes an acknowledgement with an envelope, or a pull with none. */
export class HostChannelAnswerError extends Error
{
    private static readonly ErrorName = 'HostChannelAnswerError'
    private static readonly Text = 'the platform answered the host with an unexpected reply'

    public constructor()
    {
        super(HostChannelAnswerError.Text)
        this.name = HostChannelAnswerError.ErrorName
    }
}

/**
 * The enrolled host's side of the agent channel: every message signed as Participant.Host(HostId) to the platform,
 * every platform message verified against the adopted trust root and addressed to this host (EnvelopeVerifier).
 */
export class HostChannel
{
    private readonly signer: EnvelopeSigner
    private readonly verifier: EnvelopeVerifier
    public readonly Self: Participant

    public constructor(key: SigningKeyPair, enrolment: HostEnrolmentState, private readonly channel: IAgentChannel, clock: IProtocolClock = new SystemProtocolClock())
    {
        this.Self = Participant.Host(enrolment.HostId)
        this.signer = new EnvelopeSigner(key, this.Self, clock)
        this.verifier = new EnvelopeVerifier({
            Self: this.Self,
            Keys: new KeyDirectory().Add(Participant.Platform, enrolment.TrustRoot),
            Nonces: new InMemoryNonceLedger(clock),
            Clock: clock,
        })
    }

    /** Sends a message the platform acknowledges (204): a report, a result, a credential handover. */
    public async Notify(kind: MessageKind, body: IMessageBody): Promise<void>
    {
        const reply = await this.channel.Exchange(this.signer.Sign(kind, Participant.Platform, body))
        if (reply !== null)
        {
            throw new HostChannelAnswerError()
        }
    }

    /** One pull: the verified batch (its items still to be verified one by one). */
    public async Pull(after: number, max: number = Pull.MaxItems): Promise<PullBatch>
    {
        const reply = await this.channel.Exchange(this.signer.Sign(MessageKind.Pull, Participant.Platform, Pull.Create(after, max)))
        if (reply === null)
        {
            throw new HostChannelAnswerError()
        }
        return (await this.verifier.Verify(reply, MessageKind.PullBatch, PullBatch)).Body
    }

    /** A pulled placement request, verified: platform-signed, addressed to this host, fresh, never seen before. */
    public VerifyPlacement(item: SignedEnvelope): Promise<VerifiedMessage<PlacementRequest>>
    {
        return this.verifier.Verify(item, MessageKind.PlacementRequest, PlacementRequest)
    }
}
