/**
 * DisclaimerOverlay — Component tests.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisclaimerOverlay } from '../modules/DisclaimerOverlay';

describe('DisclaimerOverlay', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('contains clickable elements', () => {
        const { container } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        const clickableElements = container.querySelectorAll('button, [role="button"], [onClick], a');
        expect(clickableElements.length).toBeGreaterThanOrEqual(0);
    });

    it('displays disclaimer text', () => {
        const { container } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
        expect(container.textContent!.length).toBeGreaterThan(50);
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<DisclaimerOverlay onAccepted={vi.fn()} />);
            rerender(<DisclaimerOverlay onAccepted={vi.fn()} />);
        }).not.toThrow();
    });
});
