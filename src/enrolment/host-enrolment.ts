import { readFile } from 'node:fs/promises'
import {
    AgentChannelUnavailableError, AgentExchangeRefusal, ClusterKind, EnrolmentHandshake, EnrolmentMismatch, EnrolmentMismatchError, EnvelopeSigner,
    HostEnrolmentRequest, InMemoryNonceLedger, MessageKind, Participant, ParticipantRole, ProtocolVerificationError, SystemProtocolClock,
    type IAgentChannel, type IProtocolClock, type SignedEnvelope, type SigningKeyPair, type SigningPublicKey,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HostEnrolmentState, type HostEnrolmentStore } from './host-enrolment-state.js'

/** Why the machine did not enrol: a fixed set, no text from the platform. */
export enum HostEnrolmentFailure
{
    InvalidCode = 'invalid-code',
    Mismatch = 'mismatch',
    KeyRegistered = 'key-registered',
    TrustRootMismatch = 'trust-root-mismatch',
    NoCode = 'no-code',
    Unavailable = 'unavailable',
}

export class HostEnrolmentRefusedError extends Error
{
    private static readonly ErrorName = 'HostEnrolmentRefusedError'
    private static readonly Prefix = 'host enrolment refused: '

    public constructor(public readonly Failure: HostEnrolmentFailure)
    {
        super(HostEnrolmentRefusedError.Prefix + Failure)
        this.name = HostEnrolmentRefusedError.ErrorName
    }
}

/** Where the one-time enrolment code comes from: read only while the machine is not enrolled. */
export interface IEnrolmentCodeSource
{
    Read(): Promise<string>
}

/** The code in a mounted file (PRAGMATIC_HOST_ENROLMENT_CODE_FILE), surrounding whitespace dropped. */
export class FileEnrolmentCodeSource implements IEnrolmentCodeSource
{
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly path: string | undefined)
    {
    }

    public async Read(): Promise<string>
    {
        if (this.path === undefined)
        {
            throw new HostEnrolmentRefusedError(HostEnrolmentFailure.NoCode)
        }
        let text: string
        try
        {
            text = await readFile(this.path, FileEnrolmentCodeSource.Utf8)
        }
        catch
        {
            throw new HostEnrolmentRefusedError(HostEnrolmentFailure.NoCode)
        }
        const code = text.trim()
        if (code.length === 0)
        {
            throw new HostEnrolmentRefusedError(HostEnrolmentFailure.NoCode)
        }
        return code
    }
}

export interface HostEnrolmentOptions
{
    Key: SigningKeyPair
    Channel: IAgentChannel
    Store: HostEnrolmentStore
    PinnedTrustRoot: SigningPublicKey
    MachineName: string
    MeshAddress: string
    AgentVersion: string
    Clock?: IProtocolClock
}

/**
 * Enrolling the machine, once (C5.1): a HostEnrolmentRequest (code, machine name, the host key's public half, cluster
 * kind kind, agent version, mesh address) self-signed by the host key goes over the agent channel; the answer is
 * accepted only by EnrolmentHandshake.AcceptHost with the pinned trust root (signed by it, addressed to this key,
 * fresh, answering this request's nonce); only then is the enrolment stored, with the platform's sealing key the
 * cluster credentials are sealed to. A refusal maps to HostEnrolmentFailure; nothing from the platform's answer
 * travels further. An enrolled machine never reads its code again (`EnsureEnrolled`).
 */
export class HostEnrolment
{
    private static readonly PlatformCodes: ReadonlyMap<AgentExchangeRefusal, HostEnrolmentFailure> = new Map([
        [AgentExchangeRefusal.InvalidCode, HostEnrolmentFailure.InvalidCode],
        [AgentExchangeRefusal.Mismatch, HostEnrolmentFailure.Mismatch],
        [AgentExchangeRefusal.KeyRegistered, HostEnrolmentFailure.KeyRegistered],
    ])
    private readonly clock: IProtocolClock

    public constructor(private readonly options: HostEnrolmentOptions)
    {
        this.clock = options.Clock ?? new SystemProtocolClock()
    }

    /** The stored enrolment, else an enrolment with the code `codes` reads (read only then). */
    public async EnsureEnrolled(codes: IEnrolmentCodeSource): Promise<HostEnrolmentState>
    {
        const stored = await this.options.Store.Read()
        if (stored !== undefined)
        {
            return stored
        }
        return this.Enrol(await codes.Read())
    }

    public async Enrol(code: string): Promise<HostEnrolmentState>
    {
        const o = this.options
        const body = HostEnrolmentRequest.Create({
            EnrolmentCode: code, MachineName: o.MachineName, PublicKey: o.Key.PublicKey, ClusterKind: ClusterKind.Kind, AgentVersion: o.AgentVersion, MeshAddress: o.MeshAddress,
        })
        const request = EnvelopeSigner.SelfSigned(o.Key, ParticipantRole.Host, this.clock).Sign(MessageKind.HostEnrolmentRequest, Participant.Platform, body)
        let response: SignedEnvelope | null
        try
        {
            response = await o.Channel.Exchange(request)
        }
        catch (error)
        {
            throw new HostEnrolmentRefusedError(HostEnrolment.FailureOf(error))
        }
        if (response === null)
        {
            throw new HostEnrolmentRefusedError(HostEnrolmentFailure.Unavailable)
        }
        const handshake = new EnrolmentHandshake({ Clock: this.clock, Nonces: new InMemoryNonceLedger(this.clock), PinnedTrustRoot: o.PinnedTrustRoot })
        let state: HostEnrolmentState
        try
        {
            const verified = await handshake.AcceptHost(response, request)
            state = new HostEnrolmentState(verified.Body.HostId, verified.Body.SealingKey, verified.Body.ChannelUrl, verified.Body.TrustRoot)
        }
        catch (error)
        {
            if (error instanceof EnrolmentMismatchError && error.Reason === EnrolmentMismatch.UntrustedRoot)
            {
                throw new HostEnrolmentRefusedError(HostEnrolmentFailure.TrustRootMismatch)
            }
            if (error instanceof EnrolmentMismatchError || error instanceof ProtocolVerificationError)
            {
                throw new HostEnrolmentRefusedError(HostEnrolmentFailure.Unavailable)
            }
            throw error
        }
        await o.Store.Write(state)
        return state
    }

    private static FailureOf(error: unknown): HostEnrolmentFailure
    {
        if (error instanceof AgentChannelUnavailableError && error.Code !== null)
        {
            return HostEnrolment.PlatformCodes.get(error.Code) ?? HostEnrolmentFailure.Unavailable
        }
        return HostEnrolmentFailure.Unavailable
    }
}
