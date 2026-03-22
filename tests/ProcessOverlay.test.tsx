/**
 * ProcessOverlay — loading overlay with spinner and message.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock the theme module
vi.mock('../theme', () => ({
    t: {
        border: { default: 'border border-white/10' },
    },
}));

import { ProcessOverlay } from '../components/ProcessOverlay';

describe('ProcessOverlay', () => {
    it('renders default message when none provided', () => {
        render(<ProcessOverlay />);
        expect(screen.getByText('Updating...')).toBeInTheDocument();
    });

    it('renders custom message', () => {
        render(<ProcessOverlay message="Loading Marine Data..." />);
        expect(screen.getByText('Loading Marine Data...')).toBeInTheDocument();
    });

    it('has role="alert" for accessibility', () => {
        render(<ProcessOverlay />);
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('has aria-busy="true" while loading', () => {
        render(<ProcessOverlay />);
        const alert = screen.getByRole('alert');
        expect(alert.getAttribute('aria-busy')).toBe('true');
    });

    it('has aria-live="assertive" for screen readers', () => {
        render(<ProcessOverlay />);
        const alert = screen.getByRole('alert');
        expect(alert.getAttribute('aria-live')).toBe('assertive');
    });

    it('renders a spinner', () => {
        const { container } = render(<ProcessOverlay />);
        expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('covers the full viewport with fixed positioning', () => {
        const { container } = render(<ProcessOverlay />);
        const overlay = container.firstChild as HTMLElement;
        expect(overlay.className).toContain('fixed');
        expect(overlay.className).toContain('inset-0');
    });
});
