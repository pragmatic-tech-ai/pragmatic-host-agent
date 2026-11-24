import { ProtocolDecodeError, ProtocolVerificationError, Pull, type PlacementRequest } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { HostChannel } from '../channel/host-channel.js'
import { AcceptOutcome } from './placement-reconciler.js'
import type { PlacementStore } from './placement-store.js'

/** Takes a verified placement request (PlacementReconciler.Accept). */
export interface IPlacementSink
{
    Accept(request: PlacementRequest): Promise<AcceptOutcome>
}

/**
 * Pulls the host's placement queue (`Pull{After: cursor, Max}` -> `PullBatch`): each item is verified on its own
 * (platform-signed, addressed to this host, fresh) and recorded, and the cursor moves past the batch only when every
 * item was taken. An item that is permanently invalid (its signature, addressing, freshness or shape) is logged and
 * skipped. A transient failure (verifying it threw something else) stops the batch; a placement being worked on (Busy)
 * does not: the other placements' items are still taken. Either leaves the cursor where it was, so the batch is pulled
 * again on the next pass (a request taken twice changes nothing: versions only rise).
 * Pulls again while a batch comes back full (bounded).
 */
export class PlacementPuller
{
    public static readonly MaxBatches = 10
    private static readonly ItemRefused = 'placement item refused'
    private static readonly ItemDeferred = 'placement item deferred to the next pull'
    private static readonly ErrorKey = 'error'
    private static readonly PlacementKey = 'placementId'
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
        let recorded = 0
        for (let batchIndex = 0; batchIndex < P.MaxBatches; batchIndex += 1)
        {
            const after = await this.store.Cursor()
            const batch = await this.channel.Pull(after, Pull.MaxItems)
            let complete = true
            for (const item of batch.Items)
            {
                let request: PlacementRequest
                try
                {
                    request = (await this.channel.VerifyPlacement(item)).Body
                }
                catch (error)
                {
                    if (error instanceof ProtocolVerificationError || error instanceof ProtocolDecodeError)
                    {
                        this.logger.Warn(P.ItemRefused, { [P.ErrorKey]: error.message })
                        continue
                    }
                    this.logger.Warn(P.ItemDeferred, { [P.ErrorKey]: error instanceof Error ? error.message : P.Unknown })
                    complete = false
                    break
                }
                const outcome = await this.sink.Accept(request)
                if (outcome === AcceptOutcome.Busy)
                {
                    this.logger.Info(P.ItemDeferred, { [P.PlacementKey]: request.PlacementId })
                    complete = false
                    continue
                }
                if (outcome === AcceptOutcome.Recorded)
                {
                    recorded += 1
                }
            }
            if (!complete)
            {
                break
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
        return recorded
    }
}
