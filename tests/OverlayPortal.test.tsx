import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OVERLAY_Z_INDEX, OverlayPortal } from '../components/ui/OverlayPortal';

describe('OverlayPortal', () => {
    it('escapes the page stacking context and renders ordinary modals above app navigation', () => {
        const { container } = render(
            <div data-testid="page">
                <OverlayPortal>
                    <div role="dialog" aria-label="Ordinary overlay" />
                </OverlayPortal>
            </div>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Ordinary overlay' });
        const overlay = dialog.closest('[data-overlay-layer="modal"]');

        expect(overlay?.parentElement).toBe(document.body);
        expect(container).not.toContainElement(dialog);
        expect(overlay).toHaveStyle({ zIndex: OVERLAY_Z_INDEX.modal });
        expect(OVERLAY_Z_INDEX.modal).toBeGreaterThan(900);
    });

    it('places alarm overlays above the ordinary modal layer', () => {
        render(
            <OverlayPortal layer="critical">
                <div role="alertdialog" aria-label="Critical overlay" />
            </OverlayPortal>,
        );

        const dialog = screen.getByRole('alertdialog', { name: 'Critical overlay' });
        const overlay = dialog.closest('[data-overlay-layer="critical"]');

        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay).toHaveStyle({ zIndex: OVERLAY_Z_INDEX.critical });
        expect(overlay).toHaveClass('z-[2147483000]');
        expect(OVERLAY_Z_INDEX.critical).toBeGreaterThan(100_000);
        expect(OVERLAY_Z_INDEX.critical).toBeGreaterThan(OVERLAY_Z_INDEX.modal);
    });

    it('places a child workflow above its parent modal without using the alarm layer', () => {
        render(
            <OverlayPortal layer="nested">
                <div role="dialog" aria-label="Nested overlay" />
            </OverlayPortal>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Nested overlay' });
        const overlay = dialog.closest('[data-overlay-layer="nested"]');

        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay).toHaveStyle({ zIndex: OVERLAY_Z_INDEX.nested });
        expect(OVERLAY_Z_INDEX.nested).toBeGreaterThan(OVERLAY_Z_INDEX.modal);
        expect(OVERLAY_Z_INDEX.critical).toBeGreaterThan(OVERLAY_Z_INDEX.nested);
    });
});
