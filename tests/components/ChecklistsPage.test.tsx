import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock } = vi.hoisted(() => ({
    getAllMock: vi.fn(),
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getAll: getAllMock,
        create: vi.fn().mockResolvedValue({ id: 'new-entry' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        saveRun: vi.fn().mockResolvedValue({}),
    },
}));

vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        createTask: vi.fn().mockResolvedValue({ id: 'maintenance-task' }),
    },
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    generateUUID: vi.fn(() => 'run-1'),
}));

vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label, onConfirm }: { label: string; onConfirm: () => void }) => (
        <button type="button" onClick={onConfirm}>
            {label}
        </button>
    ),
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {action}
        </header>
    ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: () => <div data-testid="empty-state">No checklists</div>,
}));

vi.mock('../../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ChecklistsPage } from '../../components/vessel/ChecklistsPage';

const checklistEntries = [
    {
        id: 'heading-1',
        type: 'heading' as const,
        text: 'Before departure',
        heading_id: null,
        order: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
        id: 'item-1',
        type: 'detail' as const,
        text: 'Check bilge pump',
        heading_id: 'heading-1',
        order: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
];

function openChecklistRun() {
    const pageActions = screen.getByRole('button', { name: 'Page actions' });
    fireEvent.click(pageActions);
    fireEvent.click(screen.getByRole('button', { name: 'Run checklist inspection' }));
    return pageActions;
}

describe('ChecklistsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAllMock.mockReturnValue(checklistEntries);
    });

    it('renders the loaded checklist', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.getByText('Before departure')).toBeDefined();
        expect(screen.getByText('Check bilge pump')).toBeDefined();
    });

    it('opens run mode as a labelled modal with safe initial focus', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        openChecklistRun();

        const dialog = screen.getByRole('dialog', { name: 'Run Checklist' });
        const exitButton = screen.getByRole('button', { name: 'Exit checklist run' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.activeElement).toBe(exitButton);
        expect(screen.getByRole('progressbar', { name: 'Checklist completion' }).getAttribute('aria-valuenow')).toBe(
            '0',
        );
    });

    it('makes status changes keyboard-operable with specific action names', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        openChecklistRun();

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Check bilge pump: not checked. Change status to passed',
            }),
        );

        expect(
            screen.getByRole('button', {
                name: 'Check bilge pump: passed. Change status to failed',
            }),
        ).toBeDefined();
        expect(screen.getByRole('progressbar', { name: 'Checklist completion' }).getAttribute('aria-valuenow')).toBe(
            '1',
        );
    });

    it('exits on Escape and restores focus to the persistent page-actions control', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        const pageActions = openChecklistRun();
        const exitButton = screen.getByRole('button', { name: 'Exit checklist run' });

        fireEvent.keyDown(exitButton, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Run Checklist' })).toBeNull();
        expect(document.activeElement).toBe(pageActions);
    });
});
