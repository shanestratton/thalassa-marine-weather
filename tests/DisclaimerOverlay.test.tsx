/**
 * DisclaimerOverlay — the legal gate the whole app sits behind.
 *
 * These replace four assertions that could not fail (`expect(container)
 * .toBeDefined()`, `expect(length).toBeGreaterThanOrEqual(0)`). A green suite
 * over a component containing a hard lockout is worse than no suite at all:
 * it reports safety it never checked.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisclaimerOverlay } from '../modules/DisclaimerOverlay';
import { DISCLAIMER_VERSION } from '../modules/LegalGuard';

const ACCEPT = 'I understand, continue';

describe('DisclaimerOverlay', () => {
    beforeEach(() => vi.clearAllMocks());

    it('offers Accept when the text does not overflow — the lockout case', () => {
        // THE regression. hasScrolledToBottom used to be set only from
        // onScroll, and Accept renders only in that branch. On a viewport
        // where the disclaimer fits inside max-h-[50vh] — an iPad in
        // portrait, which TARGETED_DEVICE_FAMILY "1,2" supports — no scroll
        // event ever fired, so the app could not be entered at all.
        render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        expect(screen.getByRole('button', { name: ACCEPT })).toBeEnabled();
    });

    it('withholds Accept until genuinely overflowing text is read to the end', () => {
        // The overflow has to exist AT MOUNT: the component measures on mount
        // (that is the lockout fix), so stubbing the node afterwards would be
        // stubbing a gate that has already opened. Patch the prototype first.
        const proto = HTMLElement.prototype;
        const original = {
            scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
            clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
        };
        Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 2000 });
        Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 400 });

        try {
            const onAccepted = vi.fn();
            const { container } = render(<DisclaimerOverlay onAccepted={onAccepted} />);
            const box = container.querySelector('[role="document"]') as HTMLElement;

            // Long text, parked at the top: the gate must hold. The control is
            // on screen from the start (UX scorecard run 7), but disabled, and
            // says why.
            const accept = screen.getByRole('button', { name: ACCEPT });
            expect(accept).toBeDisabled();
            expect(accept).toHaveAccessibleDescription('Scroll to the end to continue.');
            fireEvent.click(accept);
            expect(onAccepted).not.toHaveBeenCalled();

            // Scrolled to the end: now it opens.
            Object.defineProperty(box, 'scrollTop', { configurable: true, value: 1600 });
            fireEvent.scroll(box);
            expect(screen.getByRole('button', { name: ACCEPT })).toBeEnabled();
            fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
            expect(onAccepted).toHaveBeenCalledOnce();
        } finally {
            // jsdom defines these on Element.prototype, so HTMLElement had no
            // OWN descriptor to put back — restoring only when one existed
            // left the 2000px getter shadowing it for every later test, and
            // the next one failed looking for a button the gate was holding
            // shut. Delete the shadow instead.
            for (const key of ['scrollHeight', 'clientHeight'] as const) {
                const prior = original[key];
                if (prior) Object.defineProperty(proto, key, prior);
                else delete (proto as unknown as Record<string, unknown>)[key];
            }
        }
    });

    it('records acceptance and lets the app through', () => {
        const onAccepted = vi.fn();
        render(<DisclaimerOverlay onAccepted={onAccepted} />);
        fireEvent.click(screen.getByRole('button', { name: ACCEPT }));
        expect(onAccepted).toHaveBeenCalledOnce();
    });

    it('is a labelled modal dialog', () => {
        // A legal gate a keyboard user can tab out of is not a gate.
        render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'navigation-disclaimer-title');
    });

    it('shows the disclaimer body and keeps its version as data, not copy', () => {
        const { container } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        // 'Disclaimer v1.0' read as a developer string (UX scorecard run 7).
        expect(container.textContent).not.toMatch(/Disclaimer v/);
        expect(screen.getByRole('dialog')).toHaveAttribute('data-disclaimer-version', DISCLAIMER_VERSION);
        const box = container.querySelector('[role="document"]') as HTMLElement;
        expect(box.textContent!.length).toBeGreaterThan(200);
    });

    it('opens on its title rather than ringing the text box, and takes the skip link out while up', () => {
        document.body.insertAdjacentHTML('afterbegin', '<a href="#main-content" id="skip">Skip to main content</a>');
        const skip = document.getElementById('skip')!;
        try {
            const { unmount } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
            expect(screen.getByRole('heading', { name: 'Important notice' })).toHaveFocus();
            expect(skip).toHaveAttribute('inert');
            expect(skip).toHaveAttribute('aria-hidden', 'true');
            unmount();
            expect(skip).not.toHaveAttribute('inert');
            expect(skip).not.toHaveAttribute('aria-hidden');
        } finally {
            skip.remove();
        }
    });
});
