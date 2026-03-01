/**
 * Tests for UndoToast component
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { UndoToast } from '../components/ui/UndoToast';

describe('UndoToast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders nothing when closed', () => {
        const { container } = render(
            <UndoToast isOpen={false} message="Deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />
        );
        expect(container.innerHTML).toBe('');
    });

    it('renders message when open', () => {
        render(
            <UndoToast isOpen={true} message="Item deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />
        );
        expect(screen.getByText('Item deleted')).toBeInTheDocument();
    });

    it('shows Undo button', () => {
        render(
            <UndoToast isOpen={true} message="Deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />
        );
        expect(screen.getByText('Undo')).toBeInTheDocument();
    });

    it('calls onDismiss after duration', () => {
        const onDismiss = vi.fn();
        render(
            <UndoToast isOpen={true} message="Deleted" duration={3000} onUndo={vi.fn()} onDismiss={onDismiss} />
        );
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(3000); });
        expect(onDismiss).toHaveBeenCalled();
    });

    it('calls onUndo when Undo button clicked', () => {
        vi.useRealTimers();
        const onUndo = vi.fn();
        render(
            <UndoToast isOpen={true} message="Deleted" onUndo={onUndo} onDismiss={vi.fn()} />
        );
        fireEvent.click(screen.getByText('Undo'));
        expect(onUndo).toHaveBeenCalled();
    });
});
