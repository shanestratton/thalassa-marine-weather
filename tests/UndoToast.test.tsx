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
            <UndoToast isOpen={false} message="Deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />,
        );
        expect(container.innerHTML).toBe('');
    });

    it('renders message when open', () => {
        render(<UndoToast isOpen={true} message="Item deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />);
        expect(screen.getByText('Item deleted')).toBeInTheDocument();
    });

    it('shows Undo button', () => {
        render(<UndoToast isOpen={true} message="Deleted" onUndo={vi.fn()} onDismiss={vi.fn()} />);
        expect(screen.getByText('Undo')).toBeInTheDocument();
    });

    it('calls onDismiss after duration', () => {
        const onDismiss = vi.fn();
        render(<UndoToast isOpen={true} message="Deleted" duration={3000} onUndo={vi.fn()} onDismiss={onDismiss} />);
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(onDismiss).toHaveBeenCalled();
    });

    it('calls onUndo when Undo button clicked', () => {
        vi.useRealTimers();
        const onUndo = vi.fn();
        render(<UndoToast isOpen={true} message="Deleted" onUndo={onUndo} onDismiss={vi.fn()} />);
        fireEvent.click(screen.getByText('Undo'));
        expect(onUndo).toHaveBeenCalled();
    });

    // A page that hid the toast part-way through (Equipment's detail view)
    // shows it again: it offers the time left, not a fresh five seconds.
    it('mounted with a deadline, waits only the time left and starts its bar part-drained', () => {
        vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
        const onDismiss = vi.fn();
        const { container } = render(
            <UndoToast
                isOpen={true}
                message="Deleted"
                duration={5000}
                deadline={Date.now() + 1000}
                onUndo={vi.fn()}
                onDismiss={onDismiss}
            />,
        );
        const bar = container.querySelector<HTMLElement>('[style*="undoProgress"]')!;
        expect(bar.style.animation).toContain('-4000ms');
        act(() => {
            vi.advanceTimersByTime(999);
        });
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('a deadline already past dismisses at once; a full window runs the whole bar', () => {
        vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
        const late = vi.fn();
        render(
            <UndoToast
                isOpen={true}
                message="Late"
                duration={5000}
                deadline={Date.now() - 50}
                onUndo={vi.fn()}
                onDismiss={late}
            />,
        );
        act(() => {
            vi.advanceTimersByTime(0);
        });
        expect(late).toHaveBeenCalledTimes(1);

        const fresh = vi.fn();
        const { container } = render(
            <UndoToast
                isOpen={true}
                message="Fresh"
                duration={5000}
                deadline={Date.now() + 5000}
                onUndo={vi.fn()}
                onDismiss={fresh}
            />,
        );
        expect(container.querySelector<HTMLElement>('[style*="undoProgress"]')!.style.animation).not.toContain('-');
        act(() => {
            vi.advanceTimersByTime(4999);
        });
        expect(fresh).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(fresh).toHaveBeenCalledTimes(1);
    });
});
