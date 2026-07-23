import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from '../hooks/useFocusTrap';

function FocusTrapHarness({
    active,
    empty = false,
    onEscape,
}: {
    active: boolean;
    empty?: boolean;
    onEscape: () => void;
}) {
    const preferredRef = useRef<HTMLButtonElement>(null);
    const trapRef = useFocusTrap<HTMLDivElement>(active, {
        initialFocusRef: preferredRef,
        onEscape,
    });

    if (!active) return null;
    return (
        <div ref={trapRef} data-testid="trap">
            {!empty && (
                <>
                    <button>First</button>
                    <button ref={preferredRef}>Preferred</button>
                    <button>Last</button>
                </>
            )}
        </div>
    );
}

describe('useFocusTrap', () => {
    it('focuses the preferred control, contains Tab, handles Escape, and restores the opener', () => {
        const onEscape = vi.fn();
        const { rerender } = render(
            <>
                <button>Open dialog</button>
                <FocusTrapHarness active={false} onEscape={onEscape} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open dialog' });
        opener.focus();

        rerender(
            <>
                <button>Open dialog</button>
                <FocusTrapHarness active onEscape={onEscape} />
            </>,
        );

        const first = screen.getByRole('button', { name: 'First' });
        const preferred = screen.getByRole('button', { name: 'Preferred' });
        const last = screen.getByRole('button', { name: 'Last' });
        expect(preferred).toHaveFocus();

        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(first).toHaveFocus();
        fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
        expect(last).toHaveFocus();

        fireEvent.keyDown(last, { key: 'Escape' });
        expect(onEscape).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open dialog</button>
                <FocusTrapHarness active={false} onEscape={onEscape} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('makes an empty container focusable while active and removes the temporary tab index', () => {
        const { rerender } = render(<FocusTrapHarness active empty onEscape={() => {}} />);
        const trap = screen.getByTestId('trap');
        expect(trap).toHaveAttribute('tabindex', '-1');
        expect(trap).toHaveFocus();

        fireEvent.keyDown(trap, { key: 'Tab' });
        expect(trap).toHaveFocus();

        rerender(<FocusTrapHarness active={false} empty onEscape={() => {}} />);
        expect(trap).not.toHaveAttribute('tabindex');
    });
});
