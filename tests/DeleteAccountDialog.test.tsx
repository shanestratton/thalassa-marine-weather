import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteAccount = vi.hoisted(() => vi.fn());

vi.mock('../services/accountDeletion', () => ({
    ACCOUNT_DELETION_CONFIRMATION: 'DELETE',
    deleteCurrentAccount: deleteAccount,
}));

import { DeleteAccountDialog } from '../components/settings/DeleteAccountDialog';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('DeleteAccountDialog', () => {
    it('requires exact typed confirmation and exposes an accessible destructive dialog', async () => {
        const onDeleted = vi.fn();
        deleteAccount.mockResolvedValue({
            deleted: true,
            localCleanupComplete: true,
            appleRevocationRequired: false,
        });
        render(
            <DeleteAccountDialog isOpen accountLabel="captain@example.com" onClose={vi.fn()} onDeleted={onDeleted} />,
        );

        const dialog = screen.getByRole('alertdialog', { name: 'Permanently delete account?' });
        const input = screen.getByRole('textbox', { name: 'Type DELETE to confirm account deletion' });
        const confirm = screen.getByRole('button', { name: 'Delete forever' });
        expect(dialog).toHaveTextContent('captain@example.com');
        expect(dialog).toHaveTextContent('Limited security or legal audit records');
        expect(dialog).toHaveTextContent('shared conversation content may be anonymised');
        expect(dialog).not.toHaveTextContent('other cloud data');
        expect(input).toHaveFocus();
        expect(confirm).toBeDisabled();

        fireEvent.change(input, { target: { value: 'delete' } });
        expect(confirm).toBeDisabled();
        fireEvent.change(input, { target: { value: 'DELETE' } });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);

        await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('DELETE'));
        expect(onDeleted).toHaveBeenCalledWith({
            deleted: true,
            localCleanupComplete: true,
            appleRevocationRequired: false,
        });
    });

    it('keeps the dialog open with a retryable error and blocks Escape while deletion is in progress', async () => {
        let rejectDelete!: (error: Error) => void;
        deleteAccount.mockReturnValue(
            new Promise((_resolve, reject) => {
                rejectDelete = reject;
            }),
        );
        const onClose = vi.fn();
        render(<DeleteAccountDialog isOpen onClose={onClose} onDeleted={vi.fn()} />);

        const input = screen.getByRole('textbox', { name: 'Type DELETE to confirm account deletion' });
        fireEvent.change(input, { target: { value: 'DELETE' } });
        fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
        expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        rejectDelete(new Error('Account deletion could not be completed. Check your connection and try again.'));
        expect(await screen.findByRole('alert')).toHaveTextContent('could not be completed');
        expect(screen.getByRole('button', { name: 'Delete forever' })).toBeEnabled();
    });
});
