import React, { useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanePortalScope, panePopoverStyle } from '../context/PanePortalContext';
import { ModalSheet } from '../components/ui/ModalSheet';
import { OverlayPortal } from '../components/ui/OverlayPortal';

function Pane({ id, enabled = true, children }: { id: string; enabled?: boolean; children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <PanePortalScope enabled={enabled} paneId={id} frameRef={ref}>
            <div ref={ref} data-testid={id} data-split-pane={enabled ? id : undefined}>
                {children}
            </div>
        </PanePortalScope>
    );
}

const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

afterEach(() => vi.restoreAllMocks());

describe('PanePortalScope', () => {
    it('measures both pane hosts and follows a resized frame without remounting portal contents', () => {
        let width = 600;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return rect(this.dataset.testid === 'right' ? width + 24 : 8, 104, width, 640);
        });
        render(
            <>
                <Pane id="left">
                    <OverlayPortal>
                        <input aria-label="Left note" />
                    </OverlayPortal>
                </Pane>
                <Pane id="right">
                    <OverlayPortal>
                        <input aria-label="Right note" />
                    </OverlayPortal>
                </Pane>
            </>,
        );
        const left = document.querySelector<HTMLElement>('[data-pane-portal="left"]')!;
        const right = document.querySelector<HTMLElement>('[data-pane-portal="right"]')!;
        expect(left).toHaveStyle({ left: '8px', top: '104px', width: '600px', height: '640px' });
        expect(right).toHaveStyle({ left: '624px', width: '600px' });
        const note = screen.getByLabelText('Right note');
        fireEvent.change(note, { target: { value: 'Draft survives resize' } });
        width = 480;
        act(() => window.dispatchEvent(new Event('resize')));
        expect(right).toHaveStyle({ left: '504px', width: '480px' });
        expect(screen.getByLabelText('Right note')).toBe(note);
        expect(note).toHaveValue('Draft survives resize');
    });

    it('nested dialogs inherit their pane and critical alarms escape it', () => {
        render(
            <Pane id="left">
                <ModalSheet isOpen onClose={() => {}} title="Parent">
                    <OverlayPortal layer="nested">
                        <p>Child content</p>
                    </OverlayPortal>
                    <OverlayPortal layer="critical">
                        <p>Global alarm</p>
                    </OverlayPortal>
                </ModalSheet>
            </Pane>,
        );
        expect(screen.getByText('Child content').closest('[data-pane-portal]')).toHaveAttribute(
            'data-pane-portal',
            'left',
        );
        expect(screen.getByText('Global alarm').closest('[data-overlay-layer]')?.parentElement).toBe(document.body);
    });

    it('locks only the owning pane and leaves keyboard focus in the other pane alone', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 600, 640));
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <Pane id="left">
                        <button onClick={() => setOpen(true)}>Open left</button>
                        <ModalSheet isOpen={open} onClose={() => setOpen(false)} title="Left dialog">
                            <input aria-label="Left field" />
                        </ModalSheet>
                    </Pane>
                    <Pane id="right">
                        <input aria-label="Right field" />
                    </Pane>
                </>
            );
        }
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Open left' }));
        expect(screen.getByTestId('left')).toHaveAttribute('inert');
        expect(screen.getByTestId('right')).not.toHaveAttribute('inert');
        const right = screen.getByLabelText('Right field');
        right.focus();
        fireEvent.keyDown(right, { key: 'Tab' });
        expect(right).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
        expect(right).toHaveFocus();
        expect(screen.getByTestId('left')).not.toHaveAttribute('inert');
    });

    it('keeps the page instance mounted when split is toggled off and restores body portals', () => {
        const { rerender } = render(
            <Pane id="right">
                <input aria-label="Page draft" />
                <OverlayPortal>Menu</OverlayPortal>
            </Pane>,
        );
        const field = screen.getByLabelText('Page draft');
        rerender(
            <Pane id="right" enabled={false}>
                <input aria-label="Page draft" />
                <OverlayPortal>Menu</OverlayPortal>
            </Pane>,
        );
        expect(screen.getByLabelText('Page draft')).toBe(field);
        expect(screen.getByText('Menu').parentElement).toBe(document.body);
        expect(document.querySelector('[data-pane-portal]')).toBeNull();
    });

    it('converts right-pane menu anchors and flips above when the bottom is tight', () => {
        const target = document.createElement('div');
        target.dataset.panePortal = 'right';
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(700, 100, 500, 600));
        const style = panePopoverStyle(target, rect(1120, 620, 44, 44), 288);
        expect(style.right).toBe(36);
        expect(style.bottom).toBe(88);
        expect(style.top).toBeUndefined();
        expect(style.maxHeight).toBe(504);
    });

    it('reattaches focus trapping when an open dialog moves from split to the whole app', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 600, 640));
        const close = vi.fn();
        const dialog = (
            <ModalSheet isOpen onClose={close} title="Move dialog">
                <button>Last control</button>
            </ModalSheet>
        );
        const { rerender } = render(<Pane id="right">{dialog}</Pane>);
        rerender(
            <Pane id="right" enabled={false}>
                {dialog}
            </Pane>,
        );
        const last = screen.getByRole('button', { name: 'Last control' });
        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(screen.getByRole('button', { name: 'Close modal' })).toHaveFocus();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(close).toHaveBeenCalledOnce();
    });
});
