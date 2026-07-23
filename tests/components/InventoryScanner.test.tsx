/**
 * InventoryScanner — smoke tests (893 LOC component)
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../services/vessel/LocalInventoryService', () => ({
    LocalInventoryService: {
        getAll: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: '1' }),
        update: vi.fn().mockResolvedValue({}),
        findByBarcode: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InventoryScanner } from '../../components/vessel/InventoryScanner';
import { LocalInventoryService } from '../../services/vessel/LocalInventoryService';

describe('InventoryScanner', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<InventoryScanner onClose={vi.fn()} onItemSaved={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        render(<InventoryScanner onClose={vi.fn()} onItemSaved={vi.fn()} />);
        expect(screen.getByRole('dialog', { name: 'Inventory barcode scanner' })).toBeInTheDocument();
    });

    it('focuses the camera close action and handles Escape', () => {
        const onClose = vi.fn();
        render(<InventoryScanner onClose={onClose} onItemSaved={vi.fn()} />);
        const close = screen.getByRole('button', { name: 'Close camera' });
        const dialog = screen.getByRole('dialog', { name: 'Inventory barcode scanner' });
        expect(dialog).toContainElement(close);
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('claims the first barcode result so overlapping detector calls cannot process it twice', async () => {
        vi.useFakeTimers();
        const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {
                getUserMedia: vi.fn().mockResolvedValue({
                    getTracks: () => [],
                }),
            },
        });
        const detect = vi.fn().mockResolvedValue([{ rawValue: '9312345678901' }]);
        Object.defineProperty(window, 'BarcodeDetector', {
            configurable: true,
            value: class {
                detect = detect;
            },
        });

        try {
            render(<InventoryScanner onClose={vi.fn()} onItemSaved={vi.fn()} />);
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
                await vi.advanceTimersByTimeAsync(1_100);
            });

            expect(LocalInventoryService.findByBarcode).toHaveBeenCalledTimes(1);
            expect(screen.getByRole('dialog', { name: 'Add New Item' })).toBeInTheDocument();
        } finally {
            play.mockRestore();
            vi.useRealTimers();
        }
    });
});
