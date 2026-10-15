/**
 * Checklists get the binders' Undo, and a checklist with items can be deleted
 * after one question (126-B10b; binder audit 2026-10-09: CHK-05).
 *
 * Swipe-deleting an item gave a bare 'Item deleted' with no way back, and a
 * checklist that still had items refused with 'Remove all items from this
 * checklist first', so a twenty-item list took twenty swipes. Now an item goes
 * with the five-second Undo every other binder has (126-B10a), and a checklist
 * with items asks 'Delete “Pre-departure”?  Its 20 items go with it.' first.
 * Undo of a checklist brings its items back with it, and nothing leaves this
 * device until the window is up, so no other device loses them either
 * (checklists sync across devices since 126-B9a).
 *
 * BinderUndoDelete.test.tsx's harness: the real LocalDatabase (Filesystem is
 * the global mock) under the real LocalChecklistService and the real page; only
 * the socket and the sync engine are fakes. The service's delete is spied on,
 * not replaced, so a committed delete really reaches the outbox.
 *
 * Fictional lists only, on no particular boat: 'Pre-departure' (twenty
 * checks), 'Heavy weather' (one) and an empty 'Anchoring'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const rt = vi.hoisted(() => ({
    /** table → the newest open channel's postgres_changes callback */
    bindings: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = {
                on: (_kind: string, filter: { table: string }, callback: (payload: unknown) => void) => {
                    rt.bindings.set(filter.table, callback);
                    return api;
                },
                subscribe: () => api,
            };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    forceFullPull: vi.fn().mockResolvedValue(0),
}));
// The swipe is a native touch gesture: every card here is swiped open, so its
// Delete is the named button VoiceOver reads.
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({ swipeOffset: 100, isSwiping: false, resetSwipe: () => undefined, ref: () => undefined }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalChecklistService } from '../services/vessel/LocalChecklistService';
import { ChecklistsPage } from '../components/vessel/ChecklistsPage';
import { toast } from '../components/Toast';

const NOW = '2026-10-15T01:00:00.000Z';
let accountCounter = 0;
let me = '';

const PRE_DEPARTURE_CHECKS = [
    'Engine oil',
    'Coolant level',
    'Raw-water strainer',
    'Bilge pump',
    'Seacocks',
    'Fuel level',
    'Water tanks',
    'Battery charge',
    'Nav lights',
    'VHF radio check',
    'Lifejackets',
    'Jacklines',
    'Flares in date',
    'Fire extinguisher',
    'First-aid kit',
    'Liferaft service date',
    'EPIRB registration',
    'Anchor secured',
    'Hatches closed',
    'Weather forecast',
];
const itemId = (text: string) => `i-${text.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/** A checklist (heading) or one of its items (detail), as the server row. */
function row(id: string, text: string, headingId: string | null, order: number) {
    return {
        id,
        user_id: me,
        type: headingId ? 'detail' : 'heading',
        text,
        heading_id: headingId,
        order,
        created_at: NOW,
        updated_at: NOW,
    };
}

function rows() {
    return [
        row('h-pre', 'Pre-departure', null, 1),
        ...PRE_DEPARTURE_CHECKS.map((text, i) => row(itemId(text), text, 'h-pre', 2 + i)),
        row('h-heavy', 'Heavy weather', null, 30),
        row('i-reef', 'Reef early', 'h-heavy', 31),
        row('h-anchor', 'Anchoring', null, 40),
    ];
}

/** Let the page's promises and zero-delay timers run (setTimeout is faked). */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
    }
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
}

/** Open the page on the three lists, then fake the clock once the socket has joined. */
async function open(): Promise<{ unmount: () => void; spy: MockInstance }> {
    accountCounter += 1;
    me = `skipper-checklists-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    await mergePulledRecords('checklists', rows());
    const spy = vi.spyOn(LocalChecklistService, 'delete');
    const view = render(<ChecklistsPage onBack={vi.fn()} />);
    await screen.findByText('Weather forecast');
    // The hook subscribes after a real delay; join before the clock is faked.
    await waitFor(() => expect(rt.bindings.has('checklists')).toBe(true), { timeout: 5000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return { unmount: view.unmount, spy };
}

/** Another device saves a row: the socket's event reloads the page's rows. */
async function otherDevice(eventType: 'INSERT' | 'UPDATE', saved: ReturnType<typeof row>): Promise<void> {
    const callback = rt.bindings.get('checklists')!;
    await act(async () => {
        callback({ eventType, new: { ...saved, updated_at: new Date().toISOString() }, old: {} });
    });
    await settle();
}

const swipeDelete = (text: string) => fireEvent.click(screen.getByRole('button', { name: `Delete ${text}` }));
const clickUndo = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Undo delete action' }));
    await settle();
};
/** The checklists outbox's deletes: what would leave for every other device. */
const queuedDeletes = () =>
    getFullQueue()
        .filter((item) => item.table_name === 'checklists' && item.mutation_type === 'DELETE')
        .map((item) => item.record_id)
        .sort();
const stored = () => LocalChecklistService.getAll().map((entry) => entry.text);
const shown = (texts: readonly string[]) => texts.filter((text) => screen.queryAllByText(text).length > 0);
const ALL_PRE_DEPARTURE = ['Pre-departure', ...PRE_DEPARTURE_CHECKS];

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    rt.bindings.clear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('Checklists: an item swiped away has the binders’ Undo', () => {
    it('hides at once with "deleted" and Undo, and is deleted once the five seconds are up', async () => {
        const { spy } = await open();
        swipeDelete('Bilge pump');
        await settle();

        expect(shown(['Bilge pump'])).toEqual([]);
        expect(screen.getByText('"Bilge pump" deleted')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Undo delete action' })).toBeInTheDocument();
        expect(spy).not.toHaveBeenCalled();
        expect(queuedDeletes()).toEqual([]);
        // The old bare toast is gone: the bar says it.
        expect(toast.success).not.toHaveBeenCalledWith('Item deleted');

        await advance(5_000);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(itemId('Bilge pump'));
        expect(queuedDeletes()).toEqual([itemId('Bilge pump')]);
        expect(stored()).not.toContain('Bilge pump');
        expect(shown(['Bilge pump'])).toEqual([]);
    });

    it('Undo puts it back in its place, says so, and nothing is ever deleted', async () => {
        const { spy } = await open();
        const order = () =>
            screen
                .getAllByRole('button', { name: /^Edit checklist item: / })
                .map((button) => button.getAttribute('aria-label'));
        const before = order();
        swipeDelete('Bilge pump');
        await settle();

        await clickUndo();
        expect(order()).toEqual(before);
        expect(toast.success).toHaveBeenCalledWith('Item restored');
        await advance(10_000);
        expect(spy).not.toHaveBeenCalled();
        expect(queuedDeletes()).toEqual([]);
        expect(stored()).toContain('Bilge pump');
    });

    it('a change saved on another device inside the window does not bring it back', async () => {
        await open();
        swipeDelete('Bilge pump');
        await settle();

        await otherDevice('UPDATE', row(itemId('Seacocks'), 'Close every seacock', 'h-pre', 6));
        expect(screen.getByText('Close every seacock')).toBeInTheDocument();
        expect(shown(['Bilge pump'])).toEqual([]);
        expect(screen.getByText('"Bilge pump" deleted')).toBeInTheDocument();
    });

    it('Back inside the window: the delete still happens', async () => {
        const { unmount, spy } = await open();
        swipeDelete('Bilge pump');
        await advance(2_000);
        expect(spy).not.toHaveBeenCalled();

        unmount();
        await settle();
        expect(spy).toHaveBeenCalledWith(itemId('Bilge pump'));
        expect(queuedDeletes()).toEqual([itemId('Bilge pump')]);
    });

    it('the header counts what is on screen while the item waits', async () => {
        await open();
        expect(screen.getByText('3 checklists · 21 items')).toBeInTheDocument();
        swipeDelete('Bilge pump');
        await settle();
        expect(screen.getByText('3 checklists · 20 items')).toBeInTheDocument();
        await clickUndo();
        expect(screen.getByText('3 checklists · 21 items')).toBeInTheDocument();
    });
});

describe('Checklists: a checklist with items asks once, then goes with its Undo', () => {
    it('asks "Delete “Pre-departure”? Its 20 items go with it." and starts on Keep; Keep deletes nothing', async () => {
        const { spy } = await open();
        swipeDelete('Pre-departure');
        await settle();

        const dialog = screen.getByRole('dialog', { name: 'Delete “Pre-departure”?' });
        expect(dialog).toHaveTextContent('Its 20 items go with it.');
        expect(within(dialog).getByRole('button', { name: 'Delete checklist and items' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Keep' })).toHaveFocus();
        // No refusal any more.
        expect(toast.error).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
        await settle();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(shown(ALL_PRE_DEPARTURE)).toEqual(ALL_PRE_DEPARTURE);
        await advance(10_000);
        expect(spy).not.toHaveBeenCalled();
        expect(queuedDeletes()).toEqual([]);
    });

    it('one item is said as one', async () => {
        await open();
        swipeDelete('Heavy weather');
        await settle();

        const dialog = screen.getByRole('dialog', { name: 'Delete “Heavy weather”?' });
        expect(dialog).toHaveTextContent('Its 1 item goes with it.');
        expect(within(dialog).getByRole('button', { name: 'Delete checklist and item' })).toBeInTheDocument();
    });

    it('Delete hides the checklist and its items at once; Undo brings all of them back, and nothing reaches any other device', async () => {
        const { spy } = await open();
        swipeDelete('Pre-departure');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Delete checklist and items' }));
        await settle();

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(shown(ALL_PRE_DEPARTURE)).toEqual([]);
        expect(screen.getByText('"Pre-departure" deleted')).toBeInTheDocument();
        expect(screen.getByText('2 checklists · 1 item')).toBeInTheDocument();

        await clickUndo();
        expect(shown(ALL_PRE_DEPARTURE)).toEqual(ALL_PRE_DEPARTURE);
        expect(toast.success).toHaveBeenCalledWith('Checklist restored');
        expect(screen.getByText('3 checklists · 21 items')).toBeInTheDocument();

        await advance(10_000);
        expect(spy).not.toHaveBeenCalled();
        // Nothing queued for the server, so no other device loses a thing.
        expect(queuedDeletes()).toEqual([]);
        expect(stored()).toEqual(expect.arrayContaining(ALL_PRE_DEPARTURE));
    });

    it('when the window is up, the checklist and every one of its items are deleted, on every device', async () => {
        const { spy } = await open();
        swipeDelete('Pre-departure');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Delete checklist and items' }));
        await settle();
        expect(spy).not.toHaveBeenCalled();

        await advance(5_000);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('h-pre');
        // Each one's DELETE is in the outbox, which the sync engine pushes.
        expect(queuedDeletes()).toEqual(['h-pre', ...PRE_DEPARTURE_CHECKS.map(itemId)].sort());
        expect(stored()).toEqual(['Heavy weather', 'Reef early', 'Anchoring']);
        expect(shown(ALL_PRE_DEPARTURE)).toEqual([]);
        expect(screen.queryByText('"Pre-departure" deleted')).not.toBeInTheDocument();
    });

    it('an item added to it on another device inside the window is hidden with it, and comes back with Undo', async () => {
        await open();
        swipeDelete('Pre-departure');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Delete checklist and items' }));
        await settle();

        await otherDevice('INSERT', row('i-gas', 'Gas locker closed', 'h-pre', 25));
        expect(shown(['Gas locker closed', ...ALL_PRE_DEPARTURE])).toEqual([]);
        expect(screen.getByText('2 checklists · 1 item')).toBeInTheDocument();

        await clickUndo();
        expect(screen.getByText('Gas locker closed')).toBeInTheDocument();
        expect(shown(ALL_PRE_DEPARTURE)).toEqual(ALL_PRE_DEPARTURE);
    });

    it('an item added to it on another device inside the window is deleted with it, leaving nothing behind', async () => {
        await open();
        swipeDelete('Pre-departure');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Delete checklist and items' }));
        await settle();
        await otherDevice('INSERT', row('i-gas', 'Gas locker closed', 'h-pre', 25));

        await advance(5_000);
        expect(queuedDeletes()).toContain('i-gas');
        expect(stored()).toEqual(['Heavy weather', 'Reef early', 'Anchoring']);
    });

    it('Back inside the window: the checklist and its items still go', async () => {
        const { unmount, spy } = await open();
        swipeDelete('Pre-departure');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Delete checklist and items' }));
        await advance(1_000);

        unmount();
        await settle();
        expect(spy).toHaveBeenCalledWith('h-pre');
        expect(queuedDeletes()).toHaveLength(21);
    });

    it('an empty checklist goes at once, with its Undo, and no question', async () => {
        await open();
        swipeDelete('Anchoring');
        await settle();

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(shown(['Anchoring'])).toEqual([]);
        expect(screen.getByText('"Anchoring" deleted')).toBeInTheDocument();
        await clickUndo();
        expect(screen.getByText('Anchoring')).toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith('Checklist restored');
    });

    it("the edit form's Delete checklist is never greyed out and asks the same question", async () => {
        // The form keeps its field above the keyboard; jsdom has no scrollBy.
        vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
        await open();
        fireEvent.click(screen.getByRole('button', { name: 'Edit checklist item: Pre-departure' }));
        await settle();
        const remove = screen.getByRole('button', { name: 'Delete checklist' });
        expect(remove).toBeEnabled();
        expect(screen.queryByText(/^Remove all \d+ items? first$/)).not.toBeInTheDocument();

        fireEvent.click(remove);
        await settle();
        expect(screen.queryByRole('heading', { name: 'Edit checklist' })).not.toBeInTheDocument();
        const dialog = screen.getByRole('dialog', { name: 'Delete “Pre-departure”?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete checklist and items' }));
        await settle();
        expect(shown(ALL_PRE_DEPARTURE)).toEqual([]);
        expect(screen.getByText('"Pre-departure" deleted')).toBeInTheDocument();
    });

    it('a second delete commits the first at once: an item, then its own checklist', async () => {
        const { spy } = await open();
        swipeDelete('Reef early');
        await advance(2_000);
        swipeDelete('Heavy weather');
        await settle();

        // Reef early was Heavy weather's one item, and it is already on its way: no question.
        expect(spy.mock.calls.map(([id]) => id)).toEqual(['i-reef']);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('"Heavy weather" deleted')).toBeInTheDocument();
        await advance(5_000);
        expect(spy.mock.calls.map(([id]) => id)).toEqual(['i-reef', 'h-heavy']);
        expect(queuedDeletes()).toEqual(['h-heavy', 'i-reef']);
    });
});
