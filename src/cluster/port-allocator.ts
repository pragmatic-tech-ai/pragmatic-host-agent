import { createServer } from 'node:net'
import type { PlacementRecord } from '../placement/placement-record.js'
import type { PortRange } from '../settings/host-settings.js'

/** Every API-server port of the range is held by a placement or taken by something else on the machine. */
export class NoFreePortError extends Error
{
    private static readonly ErrorName = 'NoFreePortError'
    private static readonly Text = 'no API-server port of the host range is free'

    public constructor()
    {
        super(NoFreePortError.Text)
        this.name = NoFreePortError.ErrorName
    }
}

/** Whether a port can be bound on 127.0.0.1 now (nothing else on the machine listens there). */
export interface IPortProbe
{
    IsFree(port: number): Promise<boolean>
}

/** IPortProbe by binding the port on 127.0.0.1 and closing it at once. */
export class LoopbackPortProbe implements IPortProbe
{
    private static readonly Loopback = '127.0.0.1'
    private static readonly ErrorEvent = 'error'

    public IsFree(port: number): Promise<boolean>
    {
        return new Promise(resolve =>
        {
            const server = createServer()
            server.once(LoopbackPortProbe.ErrorEvent, () => resolve(false))
            server.listen(port, LoopbackPortProbe.Loopback, () => server.close(() => resolve(true)))
        })
    }
}

/**
 * Hands each placement one API-server port of the host's range (16444-16463 by default): the port a placement already
 * holds, else the lowest one no placement holds and nothing on the machine listens on. A placement holds its port
 * from the cluster step until its cluster is removed (the record keeps it), so two clusters never share one and a
 * restart keeps every cluster on its port; when none is left the placement is refused (NoFreePortError).
 */
export class PortAllocator
{
    public constructor(private readonly range: PortRange, private readonly probe: IPortProbe = new LoopbackPortProbe())
    {
    }

    public async Allocate(placementId: string, records: readonly PlacementRecord[]): Promise<number>
    {
        const mine = records.find(record => record.Id === placementId && record.Active && record.Json.Port !== null)
        if (mine !== undefined)
        {
            return mine.Json.Port as number
        }
        const held = new Set(records.filter(record => record.Active && record.Json.Port !== null).map(record => record.Json.Port as number))
        for (const port of this.range.Ports())
        {
            if (!held.has(port) && await this.probe.IsFree(port))
            {
                return port
            }
        }
        throw new NoFreePortError()
    }
}
