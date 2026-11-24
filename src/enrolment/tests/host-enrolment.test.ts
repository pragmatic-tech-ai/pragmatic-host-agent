import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import {
    AgentChannelFailure, AgentChannelUnavailableError, AgentExchangeRefusal, ClusterKind, HostEnrolmentRequest, MessageKind, Participant, SigningKeyPair,
    type IAgentChannel, type SignedEnvelope,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HostEnrolment, HostEnrolmentFailure, HostEnrolmentRefusedError, type IEnrolmentCodeSource } from '../host-enrolment.js'
import { HostEnrolmentStore } from '../host-enrolment-state.js'
import { TempState } from '../../tests/fakes.js'

/** A code source that counts its reads. */
class CountingCodes implements IEnrolmentCodeSource
{
    public Reads = 0

    public constructor(private readonly code: string)
    {
    }

    public Read(): Promise<string>
    {
        this.Reads += 1
        return Promise.resolve(this.code)
    }
}

/** A channel that refuses every message as the platform's exchange does, with a refusal code. */
class RefusingChannel implements IAgentChannel
{
    public constructor(private readonly code: AgentExchangeRefusal)
    {
    }

    public Exchange(_request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        return Promise.reject(new AgentChannelUnavailableError(AgentChannelFailure.Refused, 403, this.code))
    }
}

class EnrolmentFixture
{
    public static readonly Machine = 'hive-laptop'
    public static readonly Mesh = '100.64.0.7'
    public static readonly Version = '0.1.0'
    public readonly Platform = new FakePlatform()
    public readonly Channel = new FakeAgentChannel(this.Platform)
    public readonly Key = SigningKeyPair.Generate()
    public readonly State = new TempState()

    public Enrolment(pinned = this.Platform.TrustRoot, channel: IAgentChannel = this.Channel): HostEnrolment
    {
        const F = EnrolmentFixture
        return new HostEnrolment({
            Key: this.Key, Channel: channel, Store: this.Store(pinned), PinnedTrustRoot: pinned,
            MachineName: F.Machine, MeshAddress: F.Mesh, AgentVersion: F.Version, Clock: this.Platform.Clock,
        })
    }

    public Store(pinned = this.Platform.TrustRoot): HostEnrolmentStore
    {
        return new HostEnrolmentStore(this.State.Files, pinned)
    }
}

describe('HostEnrolment', () =>
{
    const fixtures: EnrolmentFixture[] = []
    after(() => fixtures.forEach(f => f.State.Dispose()))
    const fixture = (): EnrolmentFixture =>
    {
        const f = new EnrolmentFixture()
        fixtures.push(f)
        return f
    }

    it('enrols with a code against FakePlatform and stores the sealing key', async () =>
    {
        const f = fixture()
        const state = await f.Enrolment().Enrol(f.Platform.IssueHostCode())
        assert.ok(state.SealingKey.Equals(f.Platform.SealingKey.PublicKey))
        assert.equal(state.TrustRootKeyId, f.Platform.TrustRoot.KeyId)
        assert.equal(state.ChannelUrl, f.Platform.ChannelUrl)
        const record = f.Platform.Record(Participant.Host(state.HostId))
        assert.ok(record?.PublicKey.Equals(f.Key.PublicKey), 'the platform records the host key public half')
        const [request] = f.Platform.ReceivedOf<HostEnrolmentRequest>(MessageKind.HostEnrolmentRequest)
        assert.equal(request.MachineName, EnrolmentFixture.Machine)
        assert.equal(request.MeshAddress, EnrolmentFixture.Mesh)
        assert.equal(request.ClusterKind, ClusterKind.Kind)
        const stored = await f.Store().Read()
        assert.equal(stored?.HostId, state.HostId)
        assert.ok(stored?.SealingKey.Equals(state.SealingKey))
        const text = readFileSync(f.State.Files.Path(HostEnrolmentStore.FileName), 'utf8')
        assert.ok(!text.includes('PRIVATE'), 'the enrolment file holds no private key')
    })

    it('refuses a foreign trust root and stores nothing', async () =>
    {
        const f = fixture()
        const foreign = SigningKeyPair.Generate().PublicKey
        await assert.rejects(f.Enrolment(foreign).Enrol(f.Platform.IssueHostCode()),
            (error: unknown) => error instanceof HostEnrolmentRefusedError && error.Failure === HostEnrolmentFailure.TrustRootMismatch)
        assert.equal(await f.Store(foreign).Read(), undefined)
    })

    it('the code file is not read again after enrolment', async () =>
    {
        const f = fixture()
        const codes = new CountingCodes(f.Platform.IssueHostCode())
        const first = await f.Enrolment().EnsureEnrolled(codes)
        assert.equal(codes.Reads, 1)
        // A restart: a new enrolment over the same state directory.
        const again = await f.Enrolment().EnsureEnrolled(codes)
        assert.equal(codes.Reads, 1)
        assert.equal(again.HostId, first.HostId)
        assert.equal(f.Platform.ReceivedOf(MessageKind.HostEnrolmentRequest).length, 1)
    })

    it('maps the exchange refusal codes and an unusable code to fixed failures', async () =>
    {
        const f = fixture()
        for (const [code, failure] of [
            [AgentExchangeRefusal.InvalidCode, HostEnrolmentFailure.InvalidCode],
            [AgentExchangeRefusal.Mismatch, HostEnrolmentFailure.Mismatch],
            [AgentExchangeRefusal.KeyRegistered, HostEnrolmentFailure.KeyRegistered],
        ] as const)
        {
            await assert.rejects(f.Enrolment(f.Platform.TrustRoot, new RefusingChannel(code)).Enrol(new FakePlatform().IssueHostCode()),
                (error: unknown) => error instanceof HostEnrolmentRefusedError && error.Failure === failure, code)
        }
        // A code the platform does not know (the fake refuses it as it is): never stored.
        await assert.rejects(f.Enrolment().Enrol(new FakePlatform().IssueHostCode()),
            (error: unknown) => error instanceof HostEnrolmentRefusedError && error.Failure === HostEnrolmentFailure.Unavailable)
        assert.equal(await f.Store().Read(), undefined)
    })

    it('a stored enrolment under another root reads with the pinned root (a rotated pinned file wins)', async () =>
    {
        const f = fixture()
        const state = await f.Enrolment().Enrol(f.Platform.IssueHostCode())
        const rotated = SigningKeyPair.Generate().PublicKey
        const read = await f.Store(rotated).Read()
        assert.equal(read?.HostId, state.HostId)
        assert.ok(read?.TrustRoot.Equals(rotated))
    })
})
