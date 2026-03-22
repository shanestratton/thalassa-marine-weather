/**
 * Toast — Global event-based toast notification tests.
 *
 * Tests the toast API (which is synchronous) and basic ToastPortal rendering.
 * We avoid fake timers to prevent interference with the event bus.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock the typeScale module
vi.mock('../styles/typeScale', () => ({
    FONT: { size: { xs: '12px', sm: '14px' } },
    SIZE: { xs: 12, sm: 14 },
}));

import { toast, ToastPortal } from '../components/Toast';

describe('toast API', () => {
    it('toast.success returns a numeric id', () => {
        const id = toast.success('Saved!');
        expect(typeof id).toBe('number');
        expect(id).toBeGreaterThan(0);
    });

    it('toast.error returns a numeric id', () => {
        const id = toast.error('Network failed');
        expect(typeof id).toBe('number');
    });

    it('toast.info returns a numeric id', () => {
        const id = toast.info('Loading...');
        expect(typeof id).toBe('number');
    });

    it('toast.loading returns a numeric id', () => {
        const id = toast.loading('Processing...');
        expect(typeof id).toBe('number');
    });

    it('returns unique IDs for each call', () => {
        const id1 = toast.success('One');
        const id2 = toast.success('Two');
        expect(id1).not.toBe(id2);
    });
});

describe('ToastPortal', () => {
    it('renders without crashing', () => {
        const { container } = render(<ToastPortal />);
        expect(container).toBeDefined();
    });

    it('displays a toast message when emitted', async () => {
        render(<ToastPortal />);

        act(() => {
            toast.success('Route saved!');
        });

        await waitFor(
            () => {
                expect(screen.getByText('Route saved!')).toBeInTheDocument();
            },
            { timeout: 1000 },
        );
    });

    it('displays error toast', async () => {
        render(<ToastPortal />);

        act(() => {
            toast.error('Connection lost');
        });

        await waitFor(
            () => {
                expect(screen.getByText('Connection lost')).toBeInTheDocument();
            },
            { timeout: 1000 },
        );
    });
});
