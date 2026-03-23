/**
 * InventoryList — smoke tests (860 LOC component)
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
        delete: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
    },
}));
vi.mock('../../services/vessel/InventorySyncService', () => ({
    InventorySyncService: { sync: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => <div data-testid="page-header">{title}</div>,
}));
vi.mock('../../components/ui/UndoToast', () => ({ UndoToast: () => null }));
vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: () => <div data-testid="empty-state">No items</div>,
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InventoryList } from '../../components/vessel/InventoryList';

describe('InventoryList', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<InventoryList onBack={vi.fn()} onOpenScanner={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<InventoryList onBack={vi.fn()} onOpenScanner={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
