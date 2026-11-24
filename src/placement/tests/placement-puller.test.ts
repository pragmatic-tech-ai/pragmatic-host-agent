import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { EnvelopeSigner, MessageKind, Participant, PlacementRequest, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlacementStep } from '../placement-record.js'
import { PlacementPuller, type IPlacementSink } from '../placement-puller.js'
import { PlacementFixture } from './placement-fixture.js'

class RecordingSink implements IPlacementSink
{
    public readonly Accepted: PlacementRequest[] = []

    public Accept(request: PlacementRequest): Promise<void>
    {
        this.Accepted.push(request)
        return Promise.resolve()
    }
}

describe('PlacementPuller', () =>
{
    const fixtures: PlacementFixture[] = []
    after(() => fixtures.forEach(f => f.Dispose()))

    it('pulls the host queue, records each verified placement, then stores the cursor', async () =>
    {
        const f = await PlacementFixture.Enrolled()
        fixtures.push(f)
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        f.Platform.Place(f.Enrolment.HostId, PlacementRequest.Remove('p0', PlacementFixture.Tenant))
        const store = f.Store()
        const reconciler = f.Reconciler({ Store: store })
        assert.equal(await new PlacementPuller(f.Channel, store, reconciler).Pull(), 2)
        assert.equal(await store.Cursor(), 2)
        assert.equal((await store.Get('p1'))?.Step, PlacementStep.Cluster)
        assert.equal((await store.Get('p0'))?.Step, PlacementStep.Removed)
        // A restart pulls after the stored cursor: nothing again.
        const sink = new RecordingSink()
        assert.equal(await new PlacementPuller(f.Channel, f.Store(), sink).Pull(), 0)
        assert.equal(sink.Accepted.length, 0)
    })

    it('skips an item not signed by the platform trust root and still moves the cursor past it', async () =>
    {
        const f = await PlacementFixture.Enrolled()
        fixtures.push(f)
        // Queued for the host, but signed by another key claiming to be the platform.
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
})
