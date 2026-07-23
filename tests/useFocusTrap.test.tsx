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

function NestedFocusTrapHarness({
    parentActive,
    childActive,
    onParentEscape,
    onChildEscape,
}: {
    parentActive: boolean;
    childActive: boolean;
    onParentEscape: () => void;
    onChildEscape: () => void;
}) {
    const childOpenerRef = useRef<HTMLButtonElement>(null);
    const childCloseRef = useRef<HTMLButtonElement>(null);
    const parentRef = useFocusTrap<HTMLDivElement>(parentActive, {
        initialFocusRef: childOpenerRef,
        onEscape: onParentEscape,
    });
    const childRef = useFocusTrap<HTMLDivElement>(childActive, {
        initialFocusRef: childCloseRef,
        onEscape: onChildEscape,
    });

    return (
        <>
            {parentActive && (
                <div ref={parentRef} data-testid="parent-trap">
                    <button ref={childOpenerRef}>Open child</button>
                    <button>Parent last</button>
                </div>
            )}
            {childActive && (
                <div ref={childRef} data-testid="child-trap">
                    <button ref={childCloseRef}>Close child</button>
                    <button>Child last</button>
                </div>
            )}
        </>
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

    it('lets only the topmost nested dialog handle keyboard input and preserves both restore targets', () => {
        const onParentEscape = vi.fn();
        const onChildEscape = vi.fn();
        const { rerender } = render(
            <>
                <button>Launch parent</button>
                <NestedFocusTrapHarness
                    parentActive={false}
                    childActive={false}
                    onParentEscape={onParentEscape}
                    onChildEscape={onChildEscape}
                />
            </>,
        );
        const parentOpener = screen.getByRole('button', { name: 'Launch parent' });
        parentOpener.focus();

        rerender(
            <>
                <button>Launch parent</button>
                <NestedFocusTrapHarness
                    parentActive
                    childActive={false}
                    onParentEscape={onParentEscape}
                    onChildEscape={onChildEscape}
                />
            </>,
        );
        const childOpener = screen.getByRole('button', { name: 'Open child' });
        expect(childOpener).toHaveFocus();

        rerender(
            <>
                <button>Launch parent</button>
                <NestedFocusTrapHarness
                    parentActive
                    childActive
                    onParentEscape={onParentEscape}
                    onChildEscape={onChildEscape}
                />
            </>,
        );
        const childClose = screen.getByRole('button', { name: 'Close child' });
        const childLast = screen.getByRole('button', { name: 'Child last' });
        expect(childClose).toHaveFocus();

        fireEvent.keyDown(childClose, { key: 'Escape' });
        expect(onChildEscape).toHaveBeenCalledOnce();
        expect(onParentEscape).not.toHaveBeenCalled();

        childLast.focus();
        fireEvent.keyDown(childLast, { key: 'Tab' });
        expect(childClose).toHaveFocus();

        rerender(
            <>
                <button>Launch parent</button>
                <NestedFocusTrapHarness
                    parentActive
                    childActive={false}
                    onParentEscape={onParentEscape}
                    onChildEscape={onChildEscape}
                />
            </>,
        );
        expect(childOpener).toHaveFocus();

        rerender(
            <>
                <button>Launch parent</button>
                <NestedFocusTrapHarness
                    parentActive={false}
                    childActive={false}
                    onParentEscape={onParentEscape}
                    onChildEscape={onChildEscape}
                />
            </>,
        );
        expect(parentOpener).toHaveFocus();
    });
});
