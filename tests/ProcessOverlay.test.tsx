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

    it('is exposed as a labelled modal processing dialog', () => {
        render(<ProcessOverlay />);
        expect(screen.getByRole('dialog', { name: 'Updating...' })).toHaveAttribute('aria-modal', 'true');
    });

    it('has aria-busy="true" while loading', () => {
        render(<ProcessOverlay />);
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-busy')).toBe('true');
    });

    it('announces processing updates through a polite status', () => {
        render(<ProcessOverlay />);
        const status = screen.getByRole('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
    });

    it('renders a spinner', () => {
        render(<ProcessOverlay />);
        expect(document.body.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('portals above app chrome and covers the full viewport', () => {
        render(<ProcessOverlay />);
        const overlay = screen.getByRole('dialog');
        expect(overlay.className).toContain('fixed');
        expect(overlay.className).toContain('inset-0');
        expect(overlay).toHaveAttribute('data-overlay-layer', 'modal');
        expect(overlay.style.zIndex).toBe('1100');
        expect(overlay.parentElement).toBe(document.body);
    });
});
