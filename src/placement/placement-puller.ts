import { Pull, type PlacementRequest } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { HostChannel } from '../channel/host-channel.js'
import type { PlacementStore } from './placement-store.js'

/** Takes a verified placement request (PlacementReconciler.Accept). */
export interface IPlacementSink
{
    Accept(request: PlacementRequest): Promise<void>
}

/**
 * Pulls the host's placement queue (`Pull{After: cursor, Max}` -> `PullBatch`): each item is verified on its own
 * (platform-signed, addressed to this host, fresh, never seen) and recorded before the cursor moves past it, so a
 * restart never loses a pulled placement; an item that does not verify is logged and skipped. Pulls again while a batch
 * comes back full (bounded).
 */
export class PlacementPuller
{
    public static readonly MaxBatches = 10
    private static readonly ItemRefused = 'placement item refused'
    private static readonly ErrorKey = 'error'
    private static readonly Unknown = 'unknown error'

    public constructor(
        private readonly channel: HostChannel,
        private readonly store: PlacementStore,
        private readonly sink: IPlacementSink,
        private readonly logger: ILogger = new NullLogger())
    {
    }

    /** One pass: answers how many placement requests were recorded. */
    public async Pull(): Promise<number>
    {
        const P = PlacementPuller
        let accepted = 0
        for (let batchIndex = 0; batchIndex < P.MaxBatches; batchIndex += 1)
        {
            const after = await this.store.Cursor()
            const batch = await this.channel.Pull(after, Pull.MaxItems)
            for (const item of batch.Items)
            {
                let request: PlacementRequest
                try
                {
                    request = (await this.channel.VerifyPlacement(item)).Body
                }
                catch (error)
                {
                    this.logger.Warn(P.ItemRefused, { [P.ErrorKey]: error instanceof Error ? error.message : P.Unknown })
                    continue
                }
                await this.sink.Accept(request)
                accepted += 1
            }
            if (batch.Cursor !== after)
            {
                await this.store.SetCursor(batch.Cursor)
            }
            if (batch.Items.length < Pull.MaxItems)
            {
                break
            }
        }
        return accepted
    }
}
