import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { HostHealth, HostReport, PlacementState } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlacementRecord, PlacementStep, type PlacementRecordJson } from '../../placement/placement-record.js'
import { CapacityReporter, type IPlacementSource } from '../capacity-reporter.js'
import { DockerMachineProbe, MachineSample, type IMachineProbe } from '../machine-probe.js'
import { FakeProcessRunner, TempState } from '../../tests/fakes.js'

class FixedProbe implements IMachineProbe
{
    public constructor(private readonly sample: MachineSample)
    {
    }

    public Sample(): Promise<MachineSample>
    {
        return Promise.resolve(this.sample)
    }
}

class FixedPlacements implements IPlacementSource
{
    public constructor(private readonly records: PlacementRecord[])
    {
    }

    public All(): Promise<PlacementRecord[]>
    {
        return Promise.resolve(this.records)
    }
}

class ReportFixture
{
    public static Record(id: string, step: PlacementStep): PlacementRecord
    {
        const json: PlacementRecordJson = {
            PlacementId: id, Tenant: 'acme', Step: step, EngineVersion: '0.1.0', ChartDigest: null, HiveHostName: null, InstalledVersion: null, InstalledDigest: null,
            EnrolmentCode: null, Port: 16444, Rotation: 0, CredentialIssuedAt: null, Attempts: 0, PendingResult: null,
        }
        return new PlacementRecord(json)
    }
}

describe('CapacityReporter', () =>
{
    const states: TempState[] = []
    after(() => states.forEach(state => state.Dispose()))

    it('capacity reports total and allocatable CPU, memory, storage and free hive slots', async () =>
    {
        const probe = new FixedProbe(new MachineSample(true, 8000, 16000, 9000, 500, 300))
        const placements = new FixedPlacements([
            ReportFixture.Record('p1', PlacementStep.Placed),
            ReportFixture.Record('p2', PlacementStep.Engine),
            ReportFixture.Record('p3', PlacementStep.Removed),
            ReportFixture.Record('p4', PlacementStep.Failed),
        ])
        const report = await new CapacityReporter(probe, placements, 4, '0.1.0').Report()
        assert.deepEqual(report.Capacity.ToJson(), { CpuMillicores: 8000, MemoryMiB: 16000, StorageGiB: 500 })
        assert.deepEqual(report.Allocatable.ToJson(), { CpuMillicores: 4000, MemoryMiB: 9000, StorageGiB: 300 })
        assert.equal(report.HiveSlots, 2)
        assert.equal(report.Health, HostHealth.Healthy)
        assert.deepEqual(report.Placements.map(entry => entry.ToJson()), [
            { PlacementId: 'p1', State: PlacementState.Running },
            { PlacementId: 'p2', State: PlacementState.InstallingEngine },
            { PlacementId: 'p4', State: PlacementState.Failed },
        ])
        // The report is what the strict codec takes (allocatable within capacity, closed shape).
        assert.deepEqual(HostReport.Parse(report.ToJson()).ToJson(), report.ToJson())
    })

    it('a full machine reports no free slot and no allocatable CPU; Docker down or a full disk is unavailable', async () =>
    {
        const full = new FixedPlacements([ReportFixture.Record('a', PlacementStep.Placed), ReportFixture.Record('b', PlacementStep.Cluster)])
        const report = await new CapacityReporter(new FixedProbe(new MachineSample(true, 4000, 8000, 4000, 100, 50)), full, 2, '0.1.0').Report()
        assert.equal(report.HiveSlots, 0)
        assert.equal(report.Allocatable.CpuMillicores, 0)
        const down = await new CapacityReporter(new FixedProbe(new MachineSample(false, 0, 0, 0, 100, 50)), new FixedPlacements([]), 2, '0.1.0').Report()
        assert.equal(down.Health, HostHealth.Unavailable)
        const disk = await new CapacityReporter(new FixedProbe(new MachineSample(true, 4000, 8000, 4000, 100, 2)), new FixedPlacements([]), 2, '0.1.0').Report()
        assert.equal(disk.Health, HostHealth.Unavailable)
    })

    it('the Docker probe reads NCPU and MemTotal from docker info, MemAvailable from meminfo and the state directory file system', async () =>
    {
        const state = new TempState()
        states.push(state)
        const memInfo = state.Files.Path('meminfo')
        writeFileSync(memInfo, 'MemTotal:       32000000 kB\nMemAvailable:    2097152 kB\n')
        const runner = new FakeProcessRunner().OnPrefix(['docker', 'info'], () => FakeProcessRunner.Ok(JSON.stringify({ NCPU: 6, MemTotal: 8 * 1024 * 1024 * 1024 })))
        const sample = await new DockerMachineProbe(runner, state.Dir, memInfo).Sample()
        assert.deepEqual(runner.Argvs, [['docker', 'info', '--format', '{{json .}}']])
        assert.equal(sample.DockerUp, true)
        assert.equal(sample.CpuMillicores, 6000)
        assert.equal(sample.MemoryTotalMiB, 8192)
        assert.equal(sample.MemoryAvailableMiB, 2048)
        assert.ok(sample.StorageTotalGiB >= sample.StorageFreeGiB)
        const down = await new DockerMachineProbe(new FakeProcessRunner().OnPrefix(['docker'], () => FakeProcessRunner.Fail('Cannot connect to the Docker daemon')), state.Dir, memInfo).Sample()
        assert.equal(down.DockerUp, false)
        assert.equal(down.CpuMillicores, 0)
        assert.equal(down.MemoryAvailableMiB, 0)
    })
})
