/**
 * The Add item sheet and its Scan (131-B13; binder audit STORES-09, STORES-08,
 * STORES-13).
 *
 * Scanning a barcode already in Stores made a second item: the "found it,
 * change the count" view lived only in a full-screen camera nothing opened.
 * Now a scanned code already in Stores opens that item, and its ± goes through
 * the page's delta path; a new code fills the Barcode field; a refused camera
 * or a missing scanner is said inside the sheet. Fictional stores.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../../types';

const scanner = vi.hoisted(() => ({
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    scan: vi.fn(),
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../../services/vessel/LocalInventoryService', () => ({
    LocalInventoryService: {
        create: vi.fn().mockResolvedValue({ id: '1' }),
        findByBarcode: vi.fn().mockReturnValue(null),
    },
}));
vi.mock('../../services/native/dataScanner', () => ({
    BarcodeScanner: scanner,
    BarcodeFormat: {
        Ean13: 'Ean13',
        Ean8: 'Ean8',
        UpcA: 'UpcA',
        UpcE: 'UpcE',
        Code128: 'Code128',
        Code39: 'Code39',
        QrCode: 'QrCode',
    },
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InventoryScanner } from '../../components/vessel/InventoryScanner';
import { LocalInventoryService } from '../../services/vessel/LocalInventoryService';
import { SCAN_DENIED, SCAN_UNAVAILABLE } from '../../services/native/scanBarcode';

window.scrollBy = () => undefined;

const CODE = '9300000000017';

function flares(extra: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id: 'item-flares',
        user_id: 'skipper-1',
        barcode: CODE,
        item_name: 'Handheld flares',
        description: null,
        category: 'Safety',
        quantity: 3,
        min_quantity: 2,
        unit: 'whole',
        location_zone: 'Cockpit locker',
        location_specific: 'Grab bag',
        expiry_date: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...extra,
    };
}

function sheet(onAdjust = vi.fn().mockResolvedValue(null), onClose = vi.fn()) {
    render(<InventoryScanner onClose={onClose} onItemSaved={vi.fn()} onAdjust={onAdjust} />);
    return { onAdjust, onClose, form: screen.getByRole('dialog', { name: 'Add item' }) };
}

/** The iPhone app, with its scanner reading `code` (or put away with none). */
function onIphone(code: string | null) {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    scanner.checkPermissions.mockResolvedValue({ camera: 'granted' });
    scanner.scan.mockResolvedValue({ barcodes: code ? [{ rawValue: code, format: 'Ean13' }] : [] });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(LocalInventoryService.findByBarcode).mockReturnValue(null);
});

afterEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    Reflect.deleteProperty(window, 'BarcodeDetector');
    Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('the Add item sheet', () => {
    it('opens on the form: there is no full-screen camera any more', () => {
        const { form } = sheet();
        expect(screen.queryByRole('dialog', { name: 'Inventory barcode scanner' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close camera' })).not.toBeInTheDocument();
        expect(within(form).getByRole('button', { name: 'Scan barcode' })).toBeInTheDocument();
    });

    it('shows the category chooser as three columns of five categories', () => {
        const { form } = sheet();
        const grid = within(form).getByRole('group', { name: 'Store category' });
        expect(grid).toHaveClass('grid-cols-3');
        expect(within(grid).getAllByRole('button')).toHaveLength(15);
        fireEvent.click(within(grid).getByRole('button', { name: 'Electrical' }));
        expect(within(grid).getByRole('button', { name: 'Electrical' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(grid).getByRole('button', { name: 'Provisions' })).toHaveAttribute('aria-pressed', 'false');
        expect(LocalInventoryService.create).not.toHaveBeenCalled();
    });

    it('refuses a count or minimum below nothing: a typed −5 is saved as 0', async () => {
        const { form } = sheet();
        fireEvent.change(within(form).getByLabelText(/Item name/), { target: { value: 'Shackle pins' } });
        fireEvent.change(within(form).getByLabelText('Quantity'), { target: { value: '-5' } });
        fireEvent.change(within(form).getByLabelText('Min alert'), { target: { value: '-2' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));
        await waitFor(() => expect(LocalInventoryService.create).toHaveBeenCalledTimes(1));
        expect(LocalInventoryService.create).toHaveBeenCalledWith(
            expect.objectContaining({ item_name: 'Shackle pins', quantity: 0, min_quantity: 0 }),
        );
    });
});

describe('Scan on the iPhone', () => {
    it('a code already in Stores opens that item to change its count, and makes nothing new', async () => {
        onIphone(CODE);
        vi.mocked(LocalInventoryService.findByBarcode).mockReturnValue(flares());
        const onAdjust = vi.fn().mockResolvedValue(flares({ quantity: 2 }));
        const { form } = sheet(onAdjust);
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));

        const found = await screen.findByRole('dialog', { name: 'Handheld flares' });
        expect(LocalInventoryService.findByBarcode).toHaveBeenCalledWith(CODE);
        expect(found).toHaveTextContent("Already in Ship's Stores");
        expect(found).toHaveTextContent('Cockpit locker — Grab bag');
        expect(within(found).getByLabelText('Handheld flares: 3')).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Add item' })).not.toBeInTheDocument();

        // − on the page's delta path, and the sheet shows the count it left.
        fireEvent.click(within(found).getByRole('button', { name: 'Take one Handheld flares' }));
        await waitFor(() => expect(within(found).getByLabelText('Handheld flares: 2')).toBeInTheDocument());
        expect(onAdjust).toHaveBeenCalledWith('item-flares', -1);
        // At its minimum: Low, by the one rule.
        expect(found).toHaveTextContent('Low stock');
        expect(LocalInventoryService.create).not.toHaveBeenCalled();
    });

    it('+ adds one, and Done closes the sheet', async () => {
        onIphone(CODE);
        vi.mocked(LocalInventoryService.findByBarcode).mockReturnValue(flares());
        const onAdjust = vi.fn().mockResolvedValue(flares({ quantity: 4 }));
        const onClose = vi.fn();
        const { form } = sheet(onAdjust, onClose);
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        const found = await screen.findByRole('dialog', { name: 'Handheld flares' });
        fireEvent.click(within(found).getByRole('button', { name: 'Add one Handheld flares' }));
        await waitFor(() => expect(within(found).getByLabelText('Handheld flares: 4')).toBeInTheDocument());
        expect(onAdjust).toHaveBeenCalledWith('item-flares', 1);
        fireEvent.click(within(found).getByRole('button', { name: 'Done' }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('− is off when there is nothing left', async () => {
        onIphone(CODE);
        vi.mocked(LocalInventoryService.findByBarcode).mockReturnValue(flares({ quantity: 0 }));
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        const found = await screen.findByRole('dialog', { name: 'Handheld flares' });
        expect(within(found).getByRole('button', { name: 'Take one Handheld flares' })).toBeDisabled();
    });

    it('a new code fills the Barcode field and stays on the form', async () => {
        onIphone('5000000000012');
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        await waitFor(() => expect(within(form).getByDisplayValue('5000000000012')).toBeInTheDocument());
        expect(screen.getByRole('dialog', { name: 'Add item' })).toBe(form);
        expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a camera Thalassa may not use is said in the sheet, in plain words', async () => {
        onIphone(CODE);
        scanner.checkPermissions.mockResolvedValue({ camera: 'prompt' });
        scanner.requestPermissions.mockResolvedValue({ camera: 'denied' });
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        expect(await within(form).findByRole('alert')).toHaveTextContent(SCAN_DENIED);
        expect(scanner.scan).not.toHaveBeenCalled();
        expect(LocalInventoryService.findByBarcode).not.toHaveBeenCalled();
    });

    it('a scanner that fails is said in the sheet, and the next Scan clears it', async () => {
        onIphone(CODE);
        scanner.scan.mockRejectedValueOnce(new Error('VisionKit is not available'));
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        expect(await within(form).findByRole('alert')).toHaveTextContent(SCAN_UNAVAILABLE);
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        await waitFor(() => expect(within(form).getByDisplayValue(CODE)).toBeInTheDocument());
        expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a scanner put away says nothing and fills nothing', async () => {
        onIphone(null);
        scanner.scan.mockRejectedValueOnce(new Error('User cancelled'));
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        await waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(1));
        await act(async () => Promise.resolve());
        expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
        expect(LocalInventoryService.findByBarcode).not.toHaveBeenCalled();
    });
});

describe('Scan in a browser', () => {
    function camera(detect: () => Promise<{ rawValue: string }[]>) {
        const stopped = vi.fn();
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopped }] }) },
        });
        Object.defineProperty(window, 'BarcodeDetector', {
            configurable: true,
            value: class {
                detect = detect;
            },
        });
        return { stopped };
    }

    it('reads the camera in the sheet, takes the first code once, and puts the camera out', async () => {
        vi.useFakeTimers();
        try {
            const detect = vi.fn().mockResolvedValue([{ rawValue: CODE }]);
            const { stopped } = camera(detect);
            vi.mocked(LocalInventoryService.findByBarcode).mockReturnValue(flares());
            const { form } = sheet();
            fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
            expect(within(form).getByText('Scanning…')).toBeInTheDocument();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_600);
            });
            expect(screen.getByRole('dialog', { name: 'Handheld flares' })).toBeInTheDocument();
            expect(LocalInventoryService.findByBarcode).toHaveBeenCalledTimes(1);
            expect(stopped).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('Close scanner puts the camera out and reads nothing', async () => {
        const { stopped } = camera(vi.fn().mockResolvedValue([]));
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
        fireEvent.click(within(form).getByRole('button', { name: 'Close scanner' }));
        await waitFor(() => expect(stopped).toHaveBeenCalled());
        expect(within(form).queryByText('Scanning…')).not.toBeInTheDocument();
        expect(LocalInventoryService.findByBarcode).not.toHaveBeenCalled();
    });

    it('a browser with no barcode reader says so in the sheet', async () => {
        const { form } = sheet();
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        expect(await within(form).findByRole('alert')).toHaveTextContent(SCAN_UNAVAILABLE);
        expect(within(form).queryByText('Scanning…')).not.toBeInTheDocument();
    });
});
