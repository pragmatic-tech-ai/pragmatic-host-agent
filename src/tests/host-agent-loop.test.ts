import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { HostReport, MessageKind, PlacementOutcome, PlacementRequest, PlacementState, type PlacementResult } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { StructuredLogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { HostAgentLoop } from '../host-agent-loop.js'
import { PlacementPuller } from '../placement/placement-puller.js'
import { PlacementFixture } from '../placement/tests/placement-fixture.js'
import { CapacityReporter } from '../report/capacity-reporter.js'
import { MachineSample, type IMachineProbe } from '../report/machine-probe.js'

class SteadyProbe implements IMachineProbe
{
    public Sample(): Promise<MachineSample>
    {
        return Promise.resolve(new MachineSample(true, 8000, 16000, 12000, 400, 300))
    }
}

describe('HostAgentLoop', () =>
{
    const fixtures: PlacementFixture[] = []
    after(() => fixtures.forEach(f => f.Dispose()))

    it('reports capacity, pulls a placement, places it, hands over the credential and sends the result; then removes it', async () =>
    {
        const f = await PlacementFixture.Enrolled()
        fixtures.push(f)
        const lines: string[] = []
        const logger = StructuredLogger.ToSink(line => lines.push(line))
        const store = f.Store()
        const reconciler = f.Reconciler({ Store: store })
        const loop = new HostAgentLoop(f.Channel, new CapacityReporter(new SteadyProbe(), store, 4, '0.1.0'), new PlacementPuller(f.Channel, store, reconciler, logger), reconciler, logger)
        await loop.ReportOnce()
        f.Platform.Place(f.Enrolment.HostId, PlacementFixture.Place('p1'))
        await loop.WorkOnce()
        await loop.ReportOnce()
        const reports = f.Platform.ReceivedOf<HostReport>(MessageKind.HostReport)
        assert.deepEqual(reports.map(report => report.HiveSlots), [4, 3])
        assert.deepEqual(reports[1].Placements.map(entry => entry.ToJson()), [{ PlacementId: 'p1', State: PlacementState.Running }])
        assert.equal(f.Platform.Credentials.has('clusters/p1'), true)
        f.Platform.Place(f.Enrolment.HostId, PlacementRequest.Remove('p1', PlacementFixture.Tenant))
        await loop.WorkOnce()
        assert.deepEqual(f.Platform.ReceivedOf<PlacementResult>(MessageKind.PlacementResult).map(result => result.Outcome), [PlacementOutcome.Placed, PlacementOutcome.Removed])
        assert.equal(f.Driver.Clusters.size, 0)
        assert.ok(lines.every(line => !line.includes('token-1') && !line.includes('one-time-code')), 'no secret in a log line')
    })
})
