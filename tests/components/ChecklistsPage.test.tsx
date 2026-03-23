/**
 * ChecklistsPage — smoke tests (1035 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getChecklists: vi.fn().mockResolvedValue([]),
        createChecklist: vi.fn().mockResolvedValue({ id: '1' }),
        updateChecklist: vi.fn().mockResolvedValue({}),
        deleteChecklist: vi.fn().mockResolvedValue(undefined),
        getItems: vi.fn().mockResolvedValue([]),
        addItem: vi.fn().mockResolvedValue({ id: '1' }),
        updateItem: vi.fn().mockResolvedValue({}),
        deleteItem: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => <div data-testid="page-header">{title}</div>,
}));
vi.mock('../../components/ui/UndoToast', () => ({ UndoToast: () => null }));
vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: () => <div data-testid="empty-state">No checklists</div>,
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChecklistsPage } from '../../components/vessel/ChecklistsPage';

describe('ChecklistsPage', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<ChecklistsPage onBack={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<ChecklistsPage onBack={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
