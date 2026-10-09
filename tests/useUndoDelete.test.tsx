/**
 * useUndoDelete — the one undo slot every binder shares (126-B10a).
 *
 * Hide, don't remove: a deleted row stays in the page's state and is filtered
 * out by id, so no reload can bring it back and Undo can never double it. The
 * real delete is committed when the five seconds end, when a newer delete
 * takes the slot, when the app goes to the background, and when the page
 * goes away; never after an account switch. Once committed, a row stays hidden
 * until one of the page's loads no longer has it, and then its id is free.
 *
 * Fictional rows only: 'Anchor light bulb', 'Spare impeller', 'Jerry can'.
 */
import React, { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useUndoDelete } from '../hooks/useUndoDelete';

interface Row {
    id: string;
    name: string;
}

const A: Row = { id: 'row-a', name: 'Anchor light bulb' };
const B: Row = { id: 'row-b', name: 'Spare impeller' };
const C: Row = { id: 'row-c', name: 'Jerry can' };

function setup(
    options: {
        commit?: (row: Row) => Promise<void>;
        alsoHides?: (row: Row) => readonly string[];
        strict?: boolean;
    } = {},
) {
    const commit = vi.fn(options.commit ?? (async () => undefined));
    const onCommitFailed = vi.fn();
    const onRestored = vi.fn();
    const onCommitted = vi.fn();
    const hook = renderHook(
        ({ rows }: { rows: readonly Row[] }) =>
            useUndoDelete<Row>({
                rows,
                commit,
                onCommitted,
                onCommitFailed,
                onRestored,
                describe: (row) => `"${row.name}" deleted`,
                alsoHides: options.alsoHides,
            }),
        {
            initialProps: { rows: [A, B, C] },
            ...(options.strict ? { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> } : {}),
        },
    );
    /** The page loads its rows again (a new array, as every load makes). */
    const load = (rows: readonly Row[]) => hook.rerender({ rows: [...rows] });
    return { hook, commit, onCommitted, onCommitFailed, onRestored, load };
}

const committedIds = (commit: ReturnType<typeof vi.fn>) => commit.mock.calls.map(([row]) => (row as Row).id);

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

function goToBackground(): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

beforeEach(() => {
    act(() => setAuthIdentityScope('skipper-undo'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
    // Back to the jsdom prototype getters (the page is visible again).
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document as unknown as Record<string, unknown>).hidden;
    act(() => setAuthIdentityScope(null));
});

describe('useUndoDelete: remove()', () => {
    it('hides the row at once and commits it once, five seconds later; it stays hidden', async () => {
        const { hook, commit } = setup();
        const scope = getAuthIdentityScope();

        act(() => hook.result.current.remove(A));
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);
        expect(hook.result.current.toastProps).toMatchObject({
            isOpen: true,
            message: '"Anchor light bulb" deleted',
        });
        expect(hook.result.current.toastProps.key).toMatch(/^row-a@\d+$/);

        await advance(4_999);
        expect(commit).not.toHaveBeenCalled();
        await advance(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith(A, scope);
        // Committed rows stay hidden until a reload drops them from the page.
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);
        expect(hook.result.current.toastProps.isOpen).toBe(false);

        await advance(30_000);
        hook.unmount();
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('a second delete commits the first at once and gets its own fresh five seconds', async () => {
        const { hook, commit } = setup();

        act(() => hook.result.current.remove(A));
        await advance(3_000);
        act(() => hook.result.current.remove(B));
        expect(committedIds(commit)).toEqual([A.id]);
        expect(hook.result.current.toastProps.key).toMatch(/^row-b@\d+$/);
        expect(hook.result.current.toastProps.message).toBe('"Spare impeller" deleted');
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);
        expect(hook.result.current.hiddenIds.has(B.id)).toBe(true);

        // A's five seconds end here: B is not committed on A's countdown.
        await advance(2_000);
        expect(committedIds(commit)).toEqual([A.id]);
        await advance(2_999);
        expect(committedIds(commit)).toEqual([A.id]);
        await advance(1);
        expect(committedIds(commit)).toEqual([A.id, B.id]);
    });

    it('deleting the row already waiting does not commit it early or twice', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        act(() => hook.result.current.remove(A));
        expect(commit).not.toHaveBeenCalled();
        await advance(5_000);
        expect(committedIds(commit)).toEqual([A.id]);
    });

    it('hides the extra ids a row takes with it, and Undo brings them all back', async () => {
        const { hook, commit } = setup({ alsoHides: () => ['item-1', 'item-2'] });
        act(() => hook.result.current.remove(A));
        expect([...hook.result.current.hiddenIds].sort()).toEqual(['item-1', 'item-2', A.id].sort());
        act(() => {
            hook.result.current.undo();
        });
        expect(hook.result.current.hiddenIds.size).toBe(0);
        await advance(10_000);
        expect(commit).not.toHaveBeenCalled();
    });
});

describe('useUndoDelete: undo()', () => {
    it('unhides the row, never commits it, and a second Undo does nothing', async () => {
        const { hook, commit, onRestored } = setup();
        act(() => hook.result.current.remove(A));

        let restored: Row | null = null;
        act(() => {
            restored = hook.result.current.undo();
        });
        expect(restored).toEqual(A);
        expect(onRestored).toHaveBeenCalledTimes(1);
        expect(onRestored).toHaveBeenCalledWith(A);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(false);
        expect(hook.result.current.toastProps.isOpen).toBe(false);

        let again: Row | null = A;
        act(() => {
            again = hook.result.current.undo();
        });
        expect(again).toBeNull();
        expect(onRestored).toHaveBeenCalledTimes(1);

        await advance(10_000);
        hook.unmount();
        expect(commit).not.toHaveBeenCalled();
    });

    it("the toast's Undo button and its own timer go through the same slot", async () => {
        const { hook, commit, onRestored } = setup();
        act(() => hook.result.current.remove(A));
        act(() => hook.result.current.toastProps.onUndo());
        expect(onRestored).toHaveBeenCalledWith(A);

        act(() => hook.result.current.remove(B));
        const dismissB = hook.result.current.toastProps.onDismiss;
        act(() => dismissB());
        expect(committedIds(commit)).toEqual([B.id]);
        // A late timer from the same toast is a no-op.
        act(() => dismissB());
        await advance(10_000);
        expect(committedIds(commit)).toEqual([B.id]);
    });
});

describe('useUndoDelete: the delete is never lost', () => {
    it('unmount (Back, a tab switch) commits the waiting row exactly once', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        await advance(2_000);
        hook.unmount();
        expect(committedIds(commit)).toEqual([A.id]);

        window.dispatchEvent(new Event('pagehide'));
        await advance(10_000);
        expect(committedIds(commit)).toEqual([A.id]);
    });

    it('going to the background commits it once, even when pagehide follows', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        goToBackground();
        expect(committedIds(commit)).toEqual([A.id]);
        expect(hook.result.current.toastProps.isOpen).toBe(false);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);

        act(() => {
            window.dispatchEvent(new Event('pagehide'));
        });
        await advance(10_000);
        hook.unmount();
        expect(committedIds(commit)).toEqual([A.id]);
    });

    it('pagehide commits it once, and the unmount after it adds nothing', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        act(() => {
            window.dispatchEvent(new Event('pagehide'));
        });
        expect(committedIds(commit)).toEqual([A.id]);
        hook.unmount();
        await advance(10_000);
        expect(committedIds(commit)).toEqual([A.id]);
    });

    it('a visibilitychange back to visible commits nothing', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(commit).not.toHaveBeenCalled();
        expect(hook.result.current.toastProps.isOpen).toBe(true);
    });
});

describe('useUndoDelete: after the commit', () => {
    it('asks the page to reload, and lets the id go once a load no longer has the row', async () => {
        const { hook, commit, onCommitted, load } = setup();
        act(() => hook.result.current.remove(A));
        await advance(5_000);
        expect(committedIds(commit)).toEqual([A.id]);
        expect(onCommitted).toHaveBeenCalledTimes(1);
        expect(onCommitted).toHaveBeenCalledWith(A);
        // The page's rows still hold it (no load yet, or a load that began
        // before the delete landed): it stays hidden.
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);
        load([A, B, C]);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);

        load([B, C]);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(false);
        // A row made again under the same id (a Stores receipt keeps its
        // purchase's id) is a new row: it shows.
        load([{ id: A.id, name: 'Anchor light bulb (bought again)' }, B, C]);
        expect(hook.result.current.hiddenIds.size).toBe(0);
    });

    it('a load without the row keeps it hidden while it waits, and while its delete is in flight', async () => {
        let land: () => void = () => undefined;
        const { hook, load } = setup({
            commit: () =>
                new Promise<void>((resolve) => {
                    land = resolve;
                }),
        });
        act(() => hook.result.current.remove(A));
        // Deleted on another device inside the window.
        load([B, C]);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);
        await advance(5_000);
        load([B, C]);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);

        // The delete lands; the page's rows already lack it, so it is let go.
        await act(async () => land());
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(false);
    });

    it("lets go of a row and the ids it took with it, never the waiting delete's", async () => {
        const { hook, load } = setup({ alsoHides: (row) => [`${row.id}-item`] });
        act(() => hook.result.current.remove(A));
        await advance(1_000);
        act(() => hook.result.current.remove(B));
        await advance(0);
        load([B, C]);
        expect([...hook.result.current.hiddenIds].sort()).toEqual([B.id, `${B.id}-item`]);
    });

    it('nothing is reloaded for a delete made after the page has gone, or one that failed', async () => {
        const gone = setup();
        act(() => gone.hook.result.current.remove(A));
        gone.hook.unmount();
        await advance(10_000);
        expect(gone.commit).toHaveBeenCalledTimes(1);
        expect(gone.onCommitted).not.toHaveBeenCalled();

        const failed = setup({ commit: () => Promise.reject(new Error('disk full')) });
        act(() => failed.hook.result.current.remove(A));
        await advance(5_000);
        expect(failed.onCommitFailed).toHaveBeenCalledTimes(1);
        expect(failed.onCommitted).not.toHaveBeenCalled();
    });
});

describe('useUndoDelete: commitNow()', () => {
    it('commits the waiting delete at once, once; the row stays hidden and the toast closes', async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(A));
        act(() => hook.result.current.commitNow());
        expect(committedIds(commit)).toEqual([A.id]);
        expect(hook.result.current.toastProps.isOpen).toBe(false);
        expect(hook.result.current.hiddenIds.has(A.id)).toBe(true);

        act(() => hook.result.current.commitNow());
        await advance(10_000);
        hook.unmount();
        expect(committedIds(commit)).toEqual([A.id]);
    });
});

describe('useUndoDelete: the toast knows when its window closes', () => {
    it("gives the toast the delete's own deadline, which never moves", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
        const start = Date.now();
        const { hook, load } = setup();
        act(() => hook.result.current.remove(A));
        expect(hook.result.current.toastProps.deadline).toBe(start + 5_000);
        expect(hook.result.current.toastProps.key).toBe(`${A.id}@${start + 5_000}`);

        await advance(3_000);
        load([A, B, C]);
        expect(hook.result.current.toastProps.deadline).toBe(start + 5_000);
        expect(hook.result.current.toastProps.duration).toBe(5_000);

        act(() => hook.result.current.remove(B));
        expect(hook.result.current.toastProps.deadline).toBe(start + 8_000);
        await advance(5_000);
        expect(hook.result.current.toastProps.deadline).toBeUndefined();
    });
});

describe('useUndoDelete: account switch', () => {
    it("drops the previous account's waiting delete without committing it, and unhides everything", async () => {
        const { hook, commit } = setup();
        act(() => hook.result.current.remove(B));
        await advance(5_000);
        expect(committedIds(commit)).toEqual([B.id]);
        commit.mockClear();
        act(() => hook.result.current.remove(A));
        act(() => setAuthIdentityScope('skipper-other'));

        expect(hook.result.current.hiddenIds.size).toBe(0);
        expect(hook.result.current.toastProps.isOpen).toBe(false);
        await advance(10_000);
        hook.unmount();
        expect(commit).not.toHaveBeenCalled();
    });
});

describe('useUndoDelete: the commit fails', () => {
    it('shows the row again and reports it while the page is open', async () => {
        const failure = new Error('disk full');
        const { hook, onCommitFailed } = setup({ commit: () => Promise.reject(failure) });
        act(() => hook.result.current.remove(A));
        await advance(5_000);

        expect(hook.result.current.hiddenIds.has(A.id)).toBe(false);
        expect(onCommitFailed).toHaveBeenCalledTimes(1);
        expect(onCommitFailed).toHaveBeenCalledWith(A, failure);
    });

    it('says nothing once the page has gone', async () => {
        const { hook, commit, onCommitFailed } = setup({ commit: () => Promise.reject(new Error('disk full')) });
        act(() => hook.result.current.remove(A));
        hook.unmount();
        await advance(10_000);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(onCommitFailed).not.toHaveBeenCalled();
    });

    it('says nothing after an account switch', async () => {
        let reject: (error: Error) => void = () => undefined;
        const { hook, onCommitFailed } = setup({
            commit: () =>
                new Promise<void>((_, rejectCommit) => {
                    reject = rejectCommit;
                }),
        });
        act(() => hook.result.current.remove(A));
        await advance(5_000);
        act(() => setAuthIdentityScope('skipper-other'));
        await act(async () => reject(new Error('disk full')));
        expect(onCommitFailed).not.toHaveBeenCalled();
    });
});

describe('useUndoDelete under StrictMode', () => {
    it('still commits each row exactly once', async () => {
        const { hook, commit } = setup({ strict: true });
        act(() => hook.result.current.remove(A));
        await advance(1_000);
        act(() => hook.result.current.remove(B));
        await advance(5_000);
        hook.unmount();
        expect(committedIds(commit)).toEqual([A.id, B.id]);
    });

    it('an unmount after a StrictMode remount commits once', async () => {
        const { hook, commit } = setup({ strict: true });
        act(() => hook.result.current.remove(A));
        hook.unmount();
        expect(committedIds(commit)).toEqual([A.id]);
    });
});
