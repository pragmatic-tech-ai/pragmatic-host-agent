import { HostHealth, HostReport, PlacementStatus, Resources } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlacementRecord } from '../placement/placement-record.js'
import type { IMachineProbe } from './machine-probe.js'

/** The placements a report lists: the store, or a fixed list in tests. */
export interface IPlacementSource
{
    All(): Promise<PlacementRecord[]>
}

/**
 * The machine's capacity report (`HostReport`, every 30 s): the total (Capacity) and still-allocatable resources, the
 * free hive slots and every placement's state. Capacity is what Docker has and the state directory's file system;
 * allocatable CPU is the share of the free slots, allocatable memory MemAvailable, allocatable storage the free space.
 * `HiveSlots` is the slots still free (configured slots minus the placements holding one). Healthy unless Docker does not
 * answer or the disk is below the floor (then Unavailable: no new placements).
 */
export class CapacityReporter
{
    /** Below this much free storage the machine takes no new placement (a kind cluster with an engine needs room). */
    public static readonly MinFreeStorageGiB = 10

    public constructor(
        private readonly probe: IMachineProbe,
        private readonly placements: IPlacementSource,
        private readonly hiveSlots: number,
        private readonly agentVersion: string)
    {
    }

    public async Report(): Promise<HostReport>
    {
        const sample = await this.probe.Sample()
        const records = await this.placements.All()
        const held = records.filter(record => record.Active).length
        const free = Math.max(0, this.hiveSlots - held)
        const capacity = new Resources(sample.CpuMillicores, sample.MemoryTotalMiB, sample.StorageTotalGiB)
        const cpu = Math.floor((sample.CpuMillicores * free) / this.hiveSlots)
        const allocatable = new Resources(cpu, Math.min(sample.MemoryAvailableMiB, sample.MemoryTotalMiB), Math.min(sample.StorageFreeGiB, sample.StorageTotalGiB))
        const healthy = sample.DockerUp && sample.StorageFreeGiB >= CapacityReporter.MinFreeStorageGiB
        const statuses: PlacementStatus[] = []
        for (const record of records)
        {
            const state = record.State
            if (state !== undefined)
            {
                statuses.push(new PlacementStatus(record.Id, state))
            }
        }
        return HostReport.Create({
            AgentVersion: this.agentVersion,
            Health: healthy ? HostHealth.Healthy : HostHealth.Unavailable,
            Capacity: capacity,
            Allocatable: allocatable,
            HiveSlots: free,
            Placements: statuses.slice(0, HostReport.MaxPlacements),
        })
    }
}
