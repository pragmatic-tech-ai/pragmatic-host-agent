import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { EnvelopeSigner, MessageKind, Participant, SigningKeyPair, type PlacementRequest, type SignedEnvelope, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HostChannel } from '../../channel/host-channel.js'
import { PlacementStep } from '../placement-record.js'
import { PlacementPuller, type IPlacementSink } from '../placement-puller.js'
import { AcceptOutcome } from '../placement-reconciler.js'
import { PlacementFixture } from './placement-fixture.js'

class RecordingSink implements IPlacementSink
{
    public readonly Accepted: PlacementRequest[] = []
    public Busy = new Set<string>()

    public Accept(request: PlacementRequest): Promise<AcceptOutcome>
    {
        if (this.Busy.has(request.PlacementId))
        {
            return Promise.resolve(AcceptOutcome.Busy)
        }
        this.Accepted.push(request)
        return Promise.resolve(AcceptOutcome.Recorded)
    }
}

/** A channel whose placement verification fails once with something that is not a verification failure (an IO error). */
class FlakyChannel extends HostChannel
{
    public Failures = 1

    public override VerifyPlacement(item: SignedEnvelope): Promise<VerifiedMessage<PlacementRequest>>
    {
        if (this.Failures > 0)
        {
            this.Failures -= 1
            return Promise.reject(new Error('EIO: the key store could not be read'))
        }
        return super.VerifyPlacement(item)
    }
}

describe('PlacementPuller', () =>
{
    const fixtures: PlacementFixture[] = []
    after(() => fixtures.forEach(f => f.Dispose()))
    const enrolled = async (): Promise<PlacementFixture> =>
    {
        const f = await PlacementFixture.Enrolled()
        fixtures.push(f)
        return f
    }

    it('pulls the host queue, records each verified placement, then stores the cursor', async () =>
    {
        const f = await enrolled()
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Remove('p0', 1))
        const store = f.Store()
        const reconciler = f.Reconciler({ Store: store })
        assert.equal(await new PlacementPuller(f.Channel, store, reconciler).Pull(), 2)
        assert.equal(await store.Cursor(), 2)
        assert.equal((await store.Get('p1'))?.Step, PlacementStep.Cluster)
        assert.equal((await store.Get('p0'))?.Step, PlacementStep.Removed)
        const sink = new RecordingSink()
        assert.equal(await new PlacementPuller(f.Channel, f.Store(), sink).Pull(), 0)
        assert.equal(sink.Accepted.length, 0)
    })

    it('skips an item not signed by the platform trust root and still moves the cursor past it', async () =>
    {
        const f = await enrolled()
        const forged = new EnvelopeSigner(SigningKeyPair.Generate(), Participant.Platform, f.Platform.Clock)
            .Sign(MessageKind.PlacementRequest, Participant.Host(f.Enrolment.HostId), PlacementFixture.Place('evil'))
        const queue = (f.Platform as unknown as { queues: Map<string, unknown[]> }).queues
        queue.set(Participant.Host(f.Enrolment.HostId).Key, [forged])
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        const sink = new RecordingSink()
        assert.equal(await new PlacementPuller(f.Channel, f.Store(), sink).Pull(), 1)
        assert.deepEqual(sink.Accepted.map(request => request.PlacementId), ['p1'])
        assert.equal(await f.Store().Cursor(), 2)
    })

    it('a transient verification failure does not move the cursor past the item: the next pull takes it', async () =>
    {
        const f = await enrolled()
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        const flaky = new FlakyChannel(f.Key, f.Enrolment, f.Wire, f.Platform.Clock)
        const sink = new RecordingSink()
        assert.equal(await new PlacementPuller(flaky, f.Store(), sink).Pull(), 0)
        assert.equal(await f.Store().Cursor(), 0)
        assert.equal(await new PlacementPuller(flaky, f.Store(), sink).Pull(), 1)
        assert.deepEqual(sink.Accepted.map(request => request.PlacementId), ['p1'])
        assert.equal(await f.Store().Cursor(), 1)
    })

    it('a busy placement does not hold up the other placements\' items, only the cursor', async () =>
    {
        const f = await enrolled()
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Remove('p2', 2))
        const sink = new RecordingSink()
        sink.Busy.add('p1')
        assert.equal(await new PlacementPuller(f.Channel, f.Store(), sink).Pull(), 1)
        assert.deepEqual(sink.Accepted.map(request => request.PlacementId), ['p2'])
        assert.equal(await f.Store().Cursor(), 0)
    })

    it('a request naming an unreadable placement file is taken and the cursor moves past it', async () =>
    {
        const f = await enrolled()
        await f.State.Files.EnsureDir('placements')
        writeFileSync(f.State.Files.Path('placements', 'p1.json'), '{ not json')
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Remove('p1', 2))
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p2'))
        const store = f.Store()
        await new PlacementPuller(f.Channel, store, f.Reconciler({ Store: store })).Pull()
        assert.equal(await store.Cursor(), 2)
        assert.equal((await store.Get('p1'))?.Step, PlacementStep.Removed)
        assert.equal((await store.Get('p2'))?.Step, PlacementStep.Cluster)
    })

    it('a request for a placement being worked on leaves the cursor before it', async () =>
    {
        const f = await enrolled()
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        const sink = new RecordingSink()
        sink.Busy.add('p1')
        await new PlacementPuller(f.Channel, f.Store(), sink).Pull()
        assert.equal(await f.Store().Cursor(), 0)
        sink.Busy.clear()
        assert.equal(await new PlacementPuller(f.Channel, f.Store(), sink).Pull(), 1)
        assert.equal(await f.Store().Cursor(), 1)
    })
})
