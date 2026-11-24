import { readFile, statfs } from 'node:fs/promises'
import { ProcessCommand, type IProcessRunner } from '../process/process-runner.js'

/** One look at the machine: what Docker (the clusters' runtime) has, and the state directory's file system. */
export class MachineSample
{
    public constructor(
        /** Whether `docker info` answered: without it no cluster can be created or kept. */
        public readonly DockerUp: boolean,
        public readonly CpuMillicores: number,
        public readonly MemoryTotalMiB: number,
        public readonly MemoryAvailableMiB: number,
        public readonly StorageTotalGiB: number,
        public readonly StorageFreeGiB: number)
    {
    }
}

export interface IMachineProbe
{
    Sample(): Promise<MachineSample>
}

/**
 * The machine as the host agent sees it: CPUs and memory from `docker info` (the engine kind runs its nodes on: on
 * hive-laptop the WSL machine, not Windows), available memory from `/proc/meminfo` (MemAvailable, at most the total),
 * and the state directory's file system (statfs: the same numbers `df` prints).
 */
export class DockerMachineProbe implements IMachineProbe
{
    private static readonly Docker = 'docker'
    private static readonly InfoArgs: readonly string[] = ['info', '--format', '{{json .}}']
    private static readonly MemInfo = '/proc/meminfo'
    private static readonly MemAvailable = /^MemAvailable:\s+(\d+)\s+kB$/m
    private static readonly Utf8 = 'utf8'
    private static readonly KiB = 1024
    private static readonly MiB = 1024 * 1024
    private static readonly GiB = 1024 * 1024 * 1024
    private static readonly MilliPerCpu = 1000
    private static readonly InfoTimeoutMs = 30_000

    public constructor(private readonly runner: IProcessRunner, private readonly stateDir: string, private readonly memInfo: string = DockerMachineProbe.MemInfo)
    {
    }

    public async Sample(): Promise<MachineSample>
    {
        const D = DockerMachineProbe
        const info = await this.DockerInfo()
        const cpu = info === undefined ? 0 : info.Cpus * D.MilliPerCpu
        const total = info === undefined ? 0 : Math.floor(info.MemoryBytes / D.MiB)
        const available = Math.min(total, await this.AvailableMiB(total))
        const fs = await statfs(this.stateDir)
        const storageTotal = Math.floor((fs.blocks * fs.bsize) / D.GiB)
        const storageFree = Math.min(storageTotal, Math.floor((fs.bavail * fs.bsize) / D.GiB))
        return new MachineSample(info !== undefined, cpu, total, available, storageTotal, storageFree)
    }

    /** `docker info`'s NCPU and MemTotal, or undefined when Docker does not answer or says something else. */
    public async DockerInfo(): Promise<{ Cpus: number; MemoryBytes: number } | undefined>
    {
        const D = DockerMachineProbe
        const result = await this.runner.Run(new ProcessCommand(D.Docker, D.InfoArgs, undefined, D.InfoTimeoutMs))
        if (!result.Succeeded)
        {
            return undefined
        }
        try
        {
            const info = JSON.parse(result.Stdout) as { NCPU?: unknown; MemTotal?: unknown }
            if (typeof info.NCPU !== 'number' || typeof info.MemTotal !== 'number' || info.NCPU < 0 || info.MemTotal < 0)
            {
                return undefined
            }
            return { Cpus: info.NCPU, MemoryBytes: info.MemTotal }
        }
        catch
        {
            return undefined
        }
    }

    private async AvailableMiB(fallback: number): Promise<number>
    {
        const D = DockerMachineProbe
        try
        {
            const match = D.MemAvailable.exec(await readFile(this.memInfo, D.Utf8))
            return match === null ? fallback : Math.floor((Number(match[1]) * D.KiB) / D.MiB)
        }
        catch
        {
            return fallback
        }
    }
}
