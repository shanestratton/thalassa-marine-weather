/**
 * MaintenanceHub — smoke tests (970 LOC component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        getAll: vi.fn().mockResolvedValue([]),
        getTasks: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: '1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        getHistory: vi.fn().mockResolvedValue([]),
        logService: vi.fn().mockResolvedValue(undefined),
        getEngineHours: vi.fn().mockResolvedValue(0),
        setEngineHours: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../../services/MaintenanceService', () => ({
    calculateStatus: vi.fn().mockReturnValue({ light: 'green', dueLabel: 'OK', overdue: false }),
}));
vi.mock('../../services/MaintenancePdfService', () => ({
    exportChecklist: vi.fn().mockResolvedValue(undefined),
    exportServiceHistory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ children }: { children: React.ReactNode }) => <div data-testid="slide-to-action">{children}</div>,
}));
vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title }: { title: string }) => <div data-testid="page-header">{title}</div>,
}));
vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: () => <div data-testid="empty-state">No tasks</div>,
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MaintenanceHub } from '../../components/vessel/MaintenanceHub';

describe('MaintenanceHub', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<MaintenanceHub onBack={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<MaintenanceHub onBack={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
