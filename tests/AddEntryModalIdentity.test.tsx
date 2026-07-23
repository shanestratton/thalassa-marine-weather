import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    addManualEntry: vi.fn(),
    createTask: vi.fn(),
    getCurrentPosition: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        addManualEntry: mocks.addManualEntry,
    },
}));

vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        createTask: mocks.createTask,
    },
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: mocks.getCurrentPosition,
    },
}));

vi.mock('../components/Toast', () => ({
    toast: {
        success: mocks.toastSuccess,
        error: mocks.toastError,
    },
}));

vi.mock('../hooks/useAccessibility', () => ({
    useFocusTrap: () => ({ current: null }),
}));

import { AddEntryModal } from '../components/AddEntryModal';

describe('AddEntryModal account boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.createTask.mockResolvedValue({ id: 'repair-a' });
    });

    it('drops a deferred A save and repair follow-up after B becomes active', async () => {
        let resolveEntry!: (entry: { id: string }) => void;
        mocks.addManualEntry.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveEntry = resolve;
            }),
        );
        const onClose = vi.fn();
        const onSuccess = vi.fn();
        const view = render(<AddEntryModal isOpen onClose={onClose} onSuccess={onSuccess} />);

        fireEvent.click(screen.getByText('Repair'));
        fireEvent.change(screen.getByPlaceholderText(/Course change/), {
            target: { value: 'Account A leaking stern gland' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add Entry' }));

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(screen.queryByRole('dialog', { name: 'Add Log Entry' })).not.toBeInTheDocument();

        await act(async () => {
            resolveEntry({ id: 'entry-a' });
            await Promise.resolve();
        });

        expect(mocks.createTask).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();

        view.rerender(<AddEntryModal isOpen={false} onClose={onClose} onSuccess={onSuccess} />);
        view.rerender(<AddEntryModal isOpen onClose={onClose} onSuccess={onSuccess} />);
        expect(screen.getByRole('dialog', { name: 'Add Log Entry' })).toBeInTheDocument();
        expect(screen.getByPlaceholderText(/Course change/)).toHaveValue('');
    });

    it('does not append an account A GPS result or toast into B', async () => {
        let resolvePosition!: (position: { latitude: number; longitude: number }) => void;
        mocks.getCurrentPosition.mockReturnValueOnce(
            new Promise((resolve) => {
                resolvePosition = resolve;
            }),
        );
        const onClose = vi.fn();
        const view = render(<AddEntryModal isOpen onClose={onClose} onSuccess={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Fetching Pos' }));
        act(() => {
            setAuthIdentityScope('account-b');
        });

        await act(async () => {
            resolvePosition({ latitude: -27.47, longitude: 153.03 });
            await Promise.resolve();
        });

        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalled();

        view.rerender(<AddEntryModal isOpen={false} onClose={onClose} onSuccess={vi.fn()} />);
        view.rerender(<AddEntryModal isOpen onClose={onClose} onSuccess={vi.fn()} />);
        expect(screen.getByPlaceholderText(/Course change/)).toHaveValue('');
    });
});
