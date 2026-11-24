import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { describe, it } from 'node:test'
import { PlacementRecord, PlacementStep, type PlacementRecordJson } from '../../placement/placement-record.js'
import { PortRange } from '../../settings/host-settings.js'
import { LoopbackPortProbe, NoFreePortError, PortAllocator, type IPortProbe } from '../port-allocator.js'

class AllFree implements IPortProbe
{
    public IsFree(): Promise<boolean>
    {
        return Promise.resolve(true)
    }
}

class PortFixture
{
    public static Record(id: string, step: PlacementStep, port: number | null): PlacementRecord
    {
        const json: PlacementRecordJson = {
            PlacementId: id, Tenant: 'acme', Step: step, EngineVersion: null, ChartDigest: null, HiveHostName: null, InstalledVersion: null, InstalledDigest: null,
            EnrolmentCode: null, Port: port, Rotation: 0, CredentialIssuedAt: null, Attempts: 0, PendingResult: null,
        }
        return new PlacementRecord(json)
    }
}

describe('PortAllocator', () =>
{
    it('allocates distinct ports and refuses when none is free', async () =>
    {
        const allocator = new PortAllocator(PortRange.Parse('16444-16446') as PortRange, new AllFree())
        const records: PlacementRecord[] = []
        for (const id of ['a', 'b', 'c'])
        {
            records.push(PortFixture.Record(id, PlacementStep.Cluster, await allocator.Allocate(id, records)))
        }
        assert.deepEqual(records.map(record => record.Json.Port), [16444, 16445, 16446])
        await assert.rejects(allocator.Allocate('d', records), NoFreePortError)
        // A placement keeps the port it holds; a removed or failed one holds none.
        assert.equal(await allocator.Allocate('b', records), 16445)
        records[0] = PortFixture.Record('a', PlacementStep.Removed, null)
        records[2] = PortFixture.Record('c', PlacementStep.Failed, 16446)
        assert.equal(await allocator.Allocate('d', records), 16444)
    })

    it('skips a port something else on the machine listens on', async () =>
    {
        const server = createServer()
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const busy = (server.address() as { port: number }).port
        try
        {
            const probe = new LoopbackPortProbe()
            assert.equal(await probe.IsFree(busy), false)
            const allocator = new PortAllocator(new PortRange(busy, busy + 1), probe)
            // The next port may be taken too on a busy machine: then none is free, still never the busy one.
            const port = await allocator.Allocate('a', []).catch((error: unknown) => { assert.ok(error instanceof NoFreePortError); return undefined })
            assert.notEqual(port, busy)
        }
        finally
        {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })
})
