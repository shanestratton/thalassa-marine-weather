/**
 * Tests for ConfirmDialog component
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog, confirmProgressLabel } from '../components/ui/ConfirmDialog';

describe('ConfirmDialog', () => {
    const baseProps = {
        isOpen: true,
        title: 'Delete Task?',
        message: 'This cannot be undone.',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
    };

    it('renders nothing when isOpen is false', () => {
        const { container } = render(<ConfirmDialog {...baseProps} isOpen={false} />);
        expect(container.innerHTML).toBe('');
    });

    it('renders title and message', () => {
        render(<ConfirmDialog {...baseProps} />);
        expect(screen.getByText('Delete Task?')).toBeInTheDocument();
        expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    });

    it('shows default button labels', () => {
        render(<ConfirmDialog {...baseProps} />);
        expect(screen.getByText('Confirm')).toBeInTheDocument();
        expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('shows custom button labels', () => {
        render(<ConfirmDialog {...baseProps} confirmLabel="Delete" cancelLabel="Keep" />);
        expect(screen.getByText('Delete')).toBeInTheDocument();
        expect(screen.getByText('Keep')).toBeInTheDocument();
    });

    it('calls onCancel when cancel button is clicked', () => {
        const onCancel = vi.fn();
        render(<ConfirmDialog {...baseProps} onCancel={onCancel} />);
        fireEvent.click(screen.getByText('Cancel'));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('calls onConfirm when confirm button is clicked', async () => {
        const onConfirm = vi.fn();
        render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} />);
        await act(async () => {
            fireEvent.click(screen.getByText('Confirm'));
        });
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('has proper accessibility attributes', () => {
        render(<ConfirmDialog {...baseProps} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleName('Delete Task?');
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog.style.zIndex).toBe('1100');
    });

    it('shows destructive styling when destructive prop is set', () => {
        render(<ConfirmDialog {...baseProps} destructive />);
        // The confirm button should have red styling
        const confirmBtn = screen.getByText('Confirm');
        expect(confirmBtn.className).toContain('red');
    });

    it('keeps focus inside, closes on Escape, and restores the opener', () => {
        const onCancel = vi.fn();
        const { rerender } = render(
            <>
                <button>Delete task</button>
                <ConfirmDialog {...baseProps} isOpen={false} onCancel={onCancel} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Delete task' });
        opener.focus();

        rerender(
            <>
                <button>Delete task</button>
                <ConfirmDialog {...baseProps} onCancel={onCancel} />
            </>,
        );
        // Accessible names are the visible labels now (no aria-label override).
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const confirm = screen.getByRole('button', { name: 'Confirm' });
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: 'Tab' });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Delete task</button>
                <ConfirmDialog {...baseProps} isOpen={false} onCancel={onCancel} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('keeps a verb beside the spinner while onConfirm runs (UX scorecard run 9)', async () => {
        let finish!: () => void;
        const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        render(<ConfirmDialog {...baseProps} confirmLabel="Delete profile" onConfirm={onConfirm} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));
        const busy = screen.getByRole('button', { name: 'Delete profile' });
        expect(busy).toBeDisabled();
        expect(busy).toHaveTextContent('Deleting…');
        await act(async () => finish());
        expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveTextContent('Delete profile');
    });

    it('takes the busy verb from the label, or says Working…', () => {
        expect(confirmProgressLabel('Delete Anyway')).toBe('Deleting…');
        expect(confirmProgressLabel('Take over')).toBe('Taking over…');
        expect(confirmProgressLabel('Sign in')).toBe('Signing in…');
        // The Log's 'Replace' dialog.
        expect(confirmProgressLabel('Replace')).toBe('Replacing…');
        expect(confirmProgressLabel('Deleting...')).toBe('Deleting…');
        expect(confirmProgressLabel('Confirm')).toBe('Working…');
    });
});
