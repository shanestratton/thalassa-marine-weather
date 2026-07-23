import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useMenuNavigation } from '../hooks/useMenuNavigation';

function MenuHarness() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useMenuNavigation<HTMLDivElement>(open, {
        triggerRef,
        onClose: () => setOpen(false),
    });

    return (
        <>
            <button ref={triggerRef} onClick={() => setOpen((current) => !current)}>
                Locations
            </button>
            {open && (
                <div ref={menuRef} role="menu" tabIndex={-1}>
                    <button role="menuitem">First</button>
                    <button role="menuitem">Second</button>
                    <button role="menuitem">Last</button>
                </div>
            )}
        </>
    );
}

describe('useMenuNavigation', () => {
    it('focuses the first item, supports arrow/Home/End navigation, and wraps', () => {
        render(<MenuHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Locations' }));

        const first = screen.getByRole('menuitem', { name: 'First' });
        const second = screen.getByRole('menuitem', { name: 'Second' });
        const last = screen.getByRole('menuitem', { name: 'Last' });
        expect(first).toHaveFocus();

        fireEvent.keyDown(first, { key: 'ArrowDown' });
        expect(second).toHaveFocus();
        fireEvent.keyDown(second, { key: 'End' });
        expect(last).toHaveFocus();
        fireEvent.keyDown(last, { key: 'ArrowDown' });
        expect(first).toHaveFocus();
        fireEvent.keyDown(first, { key: 'ArrowUp' });
        expect(last).toHaveFocus();
        fireEvent.keyDown(last, { key: 'Home' });
        expect(first).toHaveFocus();
    });

    it('closes on Escape and restores the trigger without trapping Tab', () => {
        render(<MenuHarness />);
        const trigger = screen.getByRole('button', { name: 'Locations' });
        fireEvent.click(trigger);
        const first = screen.getByRole('menuitem', { name: 'First' });

        const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        first.dispatchEvent(tabEvent);
        expect(tabEvent.defaultPrevented).toBe(false);

        fireEvent.keyDown(first, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
