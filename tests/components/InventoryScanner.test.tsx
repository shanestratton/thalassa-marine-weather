/**
 * InventoryScanner — smoke tests (893 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
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

describe('InventoryScanner', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<InventoryScanner onBack={vi.fn()} onItemAdded={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<InventoryScanner onBack={vi.fn()} onItemAdded={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
