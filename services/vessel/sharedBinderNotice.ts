/**
 * sharedBinderNotice — say so when a sync could not keep a sailor's changes
 * to a skipper's binder.
 *
 * SyncService drops (or, for a row the sailor added, moves into their own
 * binder) a queued change to a skipper's binder once a fresh share snapshot
 * shows the skipper no longer lets this account edit it: offline adds after a
 * Leave or an unshare, or a view-only deckhand's meal that ate the skipper's
 * stores. Without a word the sailor's own typed entries would just vanish, so
 * the app listens once, centrally (useAppBootstrap), and shows a toast
 * whichever page is open.
 */
import { toast } from '../../components/Toast';
import { binderVesselName } from './sharedBinders';
import { onSyncComplete } from './SyncService';

export interface SharedBinderLoss {
    discardedShared?: number;
    rehomedShared?: number;
    sharedOwnerIds?: string[];
}

function count(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The toast copy for one sync's losses, or null when nothing was lost. */
export function sharedBinderLossMessage(
    loss: SharedBinderLoss,
    vesselName: (ownerId: string) => string | null = binderVesselName,
): string | null {
    const dropped = count(loss.discardedShared);
    const moved = count(loss.rehomedShared);
    if (!dropped && !moved) return null;
    const owners = loss.sharedOwnerIds ?? [];
    const name = owners.length === 1 ? vesselName(owners[0])?.trim() : null;
    const binder = name ? `${name}'s binder` : "your skipper's binder";
    const parts: string[] = [];
    if (dropped) {
        parts.push(
            dropped === 1 ? `1 change to ${binder} wasn't saved` : `${dropped} changes to ${binder} weren't saved`,
        );
    }
    if (moved) {
        const where = dropped ? 'to it' : `to ${binder}`;
        parts.push(
            moved === 1
                ? `1 item you added ${where} is in your own binder now`
                : `${moved} items you added ${where} are in your own binder now`,
        );
    }
    return `${parts.join(', and ')} — it's no longer shared with you to edit.`;
}

export function announceSharedBinderLoss(loss: SharedBinderLoss): void {
    const message = sharedBinderLossMessage(loss);
    if (message) toast.error(message, 8000);
}

/** Start announcing; returns the unsubscribe. */
export function watchSharedBinderLoss(): () => void {
    return onSyncComplete(announceSharedBinderLoss);
}
