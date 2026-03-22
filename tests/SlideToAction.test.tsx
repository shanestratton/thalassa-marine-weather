/**
 * SlideToAction — Component tests.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { SlideToAction } from '../components/ui/SlideToAction';

describe('SlideToAction', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<SlideToAction label="Start Tracking" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('displays the label text', () => {
        render(<SlideToAction label="Set Anchor" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(screen.getByText('Set Anchor')).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<SlideToAction label="Go" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<SlideToAction label="Slide" thumbIcon="⚓" onConfirm={vi.fn()} />);
            rerender(<SlideToAction label="Slide" thumbIcon="⚓" onConfirm={vi.fn()} />);
        }).not.toThrow();
    });
});
