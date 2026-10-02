/**
 * A sync that could not keep changes to a skipper's binder says so
 * (2026-10-02): the sailor's own typed entries must never vanish without a
 * word. No real accounts: 'skipper-1', 'Test Boat'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    toastError: vi.fn(),
    listeners: [] as Array<(result: Record<string, unknown>) => void>,
    unsubscribe: vi.fn(),
}));

vi.mock('../components/Toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (result: Record<string, unknown>) => void) => {
        mocks.listeners.push(listener);
        return mocks.unsubscribe;
    },
}));
vi.mock('../services/vessel/sharedBinders', () => ({
    binderVesselName: (ownerId: string) => (ownerId === 'skipper-1' ? 'Test Boat' : null),
}));

import { sharedBinderLossMessage, watchSharedBinderLoss } from '../services/vessel/sharedBinderNotice';

describe('shared binder loss notice', () => {
    beforeEach(() => {
        mocks.toastError.mockClear();
        mocks.unsubscribe.mockClear();
        mocks.listeners.length = 0;
    });

    it('says nothing when nothing was lost', () => {
        expect(sharedBinderLossMessage({ discardedShared: 0, rehomedShared: 0 })).toBeNull();
        expect(sharedBinderLossMessage({})).toBeNull();
    });

    it("names the boat when the snapshot still knows it, else 'your skipper's'", () => {
        expect(sharedBinderLossMessage({ discardedShared: 2, sharedOwnerIds: ['skipper-1'] })).toBe(
            "2 changes to Test Boat's binder weren't saved — it's no longer shared with you to edit.",
        );
        // After a Leave the skipper is gone from the snapshot.
        expect(sharedBinderLossMessage({ discardedShared: 1, sharedOwnerIds: ['skipper-gone'] })).toBe(
            "1 change to your skipper's binder wasn't saved — it's no longer shared with you to edit.",
        );
        // Two boats in one sync: no single name is right.
        expect(sharedBinderLossMessage({ discardedShared: 3, sharedOwnerIds: ['skipper-1', 'skipper-2'] })).toBe(
            "3 changes to your skipper's binder weren't saved — it's no longer shared with you to edit.",
        );
    });

    it('says where the adds it kept went', () => {
        expect(sharedBinderLossMessage({ rehomedShared: 1, sharedOwnerIds: ['skipper-1'] })).toBe(
            "1 item you added to Test Boat's binder is in your own binder now — it's no longer shared with you to edit.",
        );
        expect(sharedBinderLossMessage({ discardedShared: 1, rehomedShared: 2, sharedOwnerIds: ['skipper-1'] })).toBe(
            "1 change to Test Boat's binder wasn't saved, and 2 items you added to it are in your own binder now — it's no longer shared with you to edit.",
        );
    });

    it('says galley, not binder, when the changes were to a shared galley', () => {
        expect(
            sharedBinderLossMessage({ rehomedShared: 1, sharedOwnerIds: ['skipper-1'], sharedRegisters: ['galley'] }),
        ).toBe(
            "1 item you added to Test Boat's galley is in your own galley now — it's no longer shared with you to edit.",
        );
        expect(
            sharedBinderLossMessage({ discardedShared: 2, sharedOwnerIds: ['skipper-gone'], sharedRegisters: ['galley'] }),
        ).toBe("2 changes to your skipper's galley weren't saved — it's no longer shared with you to edit.");
        // A binder and the galley in one sync: the binder copy, as before.
        expect(
            sharedBinderLossMessage({
                discardedShared: 1,
                sharedOwnerIds: ['skipper-1'],
                sharedRegisters: ['stores', 'galley'],
            }),
        ).toBe("1 change to Test Boat's binder wasn't saved — it's no longer shared with you to edit.");
    });

    it('toasts once per sync that lost something, and stops when unsubscribed', () => {
        const stop = watchSharedBinderLoss();
        expect(mocks.listeners).toHaveLength(1);
        mocks.listeners[0]({ pushed: 1, pulled: 0, errors: [], discardedShared: 0, rehomedShared: 0 });
        expect(mocks.toastError).not.toHaveBeenCalled();
        mocks.listeners[0]({ pushed: 0, pulled: 0, errors: [], discardedShared: 2, sharedOwnerIds: ['skipper-1'] });
        expect(mocks.toastError).toHaveBeenCalledTimes(1);
        expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("Test Boat's binder"), 8000);
        stop();
        expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    });
});
