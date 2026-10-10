/**
 * Ship's Stores opening a box from its tag (126-11b).
 *
 * Shane, 2026-10-09: "i scan the nfc tag which is stuck on the front of the box
 * and it will show me everything that is in that box". A box link that opened
 * the app waits for the Stores page and opens on mount; one that arrives while
 * Stores is open opens straight away. A box this phone doesn't have says so,
 * and nothing about whose it is.
 *
 * The real Stores page over the real LocalDatabase (memory filesystem), as in
 * BoxSheet.test.tsx; only the socket, the sync engine and the NFC plugin
 * wrapper are fakes. Fictional and global: 'Engine room spares 3', 'Lazarette
 * bin B', 'Coffre avant'; a raw-water impeller and a pump belt labelled in
 * Japanese.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../../types';

vi.mock('../../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    forceFullPull: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/native/nfcTags', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../services/native/nfcTags')>()),
    nfcAvailable: vi.fn().mockResolvedValue(false),
    scanBoxTag: vi.fn(),
    writeBoxTag: vi.fn(),
}));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { initLocalDatabase, mergePulledRecords, updateSyncMeta } from '../../services/vessel/LocalDatabase';
import { consumePendingBox, openBoxLink } from '../../services/boxLinks';
import { boxLinkFor, nfcAvailable, scanBoxTag, writeBoxTag } from '../../services/native/nfcTags';
import { toast } from '../../components/Toast';
import { InventoryList } from '../../components/vessel/InventoryList';

window.scrollBy = () => undefined;

const NOW = '2026-10-10T01:00:00.000Z';
const ENGINE = 'b7c6d5e4-0001-4f3a-9b2c-1d0e9f8a7b01';
const LAZARETTE = 'b7c6d5e4-0002-4f3a-9b2c-1d0e9f8a7b02';
const BOW = 'b7c6d5e4-0003-4f3a-9b2c-1d0e9f8a7b03';
const NOT_HERE = "This box isn't in Ship's Stores on this phone";
let counter = 0;
let me = '';

const stores = (id: string, name: string, quantity: number, min: number, box: string | null) =>
    ({
        id,
        user_id: me,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Engine',
        quantity,
        min_quantity: min,
        unit: 'whole',
        location_zone: null,
        location_specific: null,
        expiry_date: null,
        box_id: box,
        created_at: NOW,
        updated_at: NOW,
    }) as InventoryItem;

const box = (id: string, name: string, zone: string) => ({
    id,
    user_id: me,
    name,
    location_zone: zone,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
});

async function seed(): Promise<void> {
    await mergePulledRecords('stores_boxes', [
        box(ENGINE, 'Engine room spares 3', 'Engine room'),
        box(LAZARETTE, 'Lazarette bin B', 'Lazarette'),
        box(BOW, 'Coffre avant', 'Pointe avant'),
    ]);
    await mergePulledRecords('inventory_items', [
        stores('c1d2e3f4-0001-4a5b-8c6d-7e8f9a0b1c01', 'Raw-water impeller', 3, 2, ENGINE),
        stores('c1d2e3f4-0003-4a5b-8c6d-7e8f9a0b1c03', '冷却水ポンプ ベルト', 2, 0, LAZARETTE),
    ]);
}

/** Watch the whole page for the "not on this phone" line, from before the first render. */
function watchForNotHere(): { seen: () => boolean; stop: () => void } {
    let seen = false;
    const observer = new MutationObserver(() => {
        seen ||= !!document.body.textContent?.includes(NOT_HERE);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return { seen: () => seen, stop: () => observer.disconnect() };
}

/** Let the page's re-reads land before asserting what did not happen. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
    vi.mocked(nfcAvailable).mockReset().mockResolvedValue(false);
    vi.mocked(scanBoxTag).mockReset();
    vi.mocked(writeBoxTag).mockReset();
    counter += 1;
    me = `5d6e7f80-1a2b-4c3d-8e4f-${String(counter).padStart(12, '0')}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
    await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: NOW } });
    // Nothing left over from the test before.
    consumePendingBox();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('a box from its tag', () => {
    it('a link that opened the app opens its box when Ship’s Stores mounts, with no flash of "not here"', async () => {
        await seed();
        const watch = watchForNotHere();
        act(() => {
            expect(openBoxLink(boxLinkFor(LAZARETTE))).toBe(true);
        });
        render(<InventoryList onBack={vi.fn()} />);
        const page = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        expect(within(page).getByText('冷却水ポンプ ベルト')).toBeInTheDocument();
        await settle();
        watch.stop();
        expect(watch.seen()).toBe(false);
        // Taken: it does not open again on the next visit.
        expect(consumePendingBox()).toBeNull();
    });

    it('a link that arrives while Ship’s Stores is open opens that box straight away', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Boxes' });
        act(() => {
            openBoxLink(boxLinkFor(ENGINE));
        });
        const page = await screen.findByRole('dialog', { name: 'Engine room spares 3' });
        expect(within(page).getByText('Raw-water impeller')).toBeInTheDocument();
    });

    it('an unknown box says it is not on this phone, and nothing else', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Boxes' });
        act(() => {
            openBoxLink(boxLinkFor('0f1e2d3c-4b5a-4697-8877-665544332211'));
        });
        const page = await screen.findByRole('dialog');
        expect(page).toHaveTextContent(`${NOT_HERE}.`);
        expect(page).not.toHaveTextContent(/Engine room|Lazarette|Coffre|Kestrel|0f1e2d3c/);
        expect(
            within(page)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual(['Close']);
    });

    it('a link made for another account never opens on this one', async () => {
        await seed();
        act(() => {
            openBoxLink(boxLinkFor(ENGINE));
        });
        act(() => setAuthIdentityScope('6e7f8091-2a3b-4c4d-9e5f-000000000999'));
        render(<InventoryList onBack={vi.fn()} />);
        await settle();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

describe('Write tag and Scan box', () => {
    it('are hidden on the web', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Boxes' })).getByRole('button', {
                name: /^Engine room spares 3/,
            }),
        );
        await screen.findByRole('dialog', { name: 'Engine room spares 3' });
        await settle();
        expect(screen.queryByRole('button', { name: 'Scan box' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Write tag' })).not.toBeInTheDocument();
    });

    it('are hidden on an iPhone without NFC (the plugin says no)', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Boxes' });
        await waitFor(() => expect(nfcAvailable).toHaveBeenCalled());
        await settle();
        expect(screen.queryByRole('button', { name: 'Scan box' })).not.toBeInTheDocument();
    });

    it('Scan box on an iPhone opens the box on the tag', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(nfcAvailable).mockResolvedValue(true);
        vi.mocked(scanBoxTag).mockResolvedValue({ id: BOW, words: '' });
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Scan box' }));
        const page = await screen.findByRole('dialog', { name: 'Coffre avant' });
        expect(page).toHaveTextContent('Nothing in this box yet.');
        expect(scanBoxTag).toHaveBeenCalledTimes(1);
    });

    it('Scan box in the Boxes list opens the box on the tag', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(nfcAvailable).mockResolvedValue(true);
        vi.mocked(scanBoxTag).mockResolvedValue({ id: LAZARETTE, words: '' });
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        const list = await screen.findByRole('dialog', { name: 'Boxes' });
        fireEvent.click(within(list).getByRole('button', { name: 'Scan box' }));
        const page = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        expect(within(page).getByText('冷却水ポンプ ベルト')).toBeInTheDocument();
        expect(scanBoxTag).toHaveBeenCalledTimes(1);
    });

    it('Scan box says so when the tag is not a box tag, and opens nothing', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(nfcAvailable).mockResolvedValue(true);
        vi.mocked(scanBoxTag).mockResolvedValue({ id: null, words: "This tag isn't a box tag from Thalassa." });
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Scan box' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This tag isn't a box tag from Thalassa."));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('Write tag writes this box’s link, and says the tag can be tested', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(nfcAvailable).mockResolvedValue(true);
        vi.mocked(writeBoxTag).mockResolvedValue({
            outcome: 'written',
            words: 'Tag written · hold your iPhone to it to test',
        });
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Scan box' });
        act(() => {
            openBoxLink(boxLinkFor(ENGINE));
        });
        const page = await screen.findByRole('dialog', { name: 'Engine room spares 3' });
        // The honest advice sits with the button: test one tag on the box first.
        expect(page).toHaveTextContent(/on the box first/);
        expect(page).toHaveTextContent(/anti-metal/);
        fireEvent.click(within(page).getByRole('button', { name: 'Write tag' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Tag written · hold your iPhone to it to test'));
        expect(writeBoxTag).toHaveBeenCalledWith(ENGINE);
    });

    it('Write tag says why when the tag is too small', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(nfcAvailable).mockResolvedValue(true);
        vi.mocked(writeBoxTag).mockResolvedValue({
            outcome: 'too_small',
            words: 'This tag is too small. Use NTAG213, 215 or 216.',
        });
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Scan box' });
        act(() => {
            openBoxLink(boxLinkFor(LAZARETTE));
        });
        const page = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        fireEvent.click(within(page).getByRole('button', { name: 'Write tag' }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('This tag is too small. Use NTAG213, 215 or 216.'),
        );
        expect(toast.success).not.toHaveBeenCalled();
    });
});
