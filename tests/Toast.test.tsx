/**
 * Toast — Global event-based toast notification tests.
 *
 * Tests the toast API and the portal's full notification lifecycle.
 */
import React from 'react';
import { render, renderHook, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';

// Mock the typeScale module
vi.mock('../styles/typeScale', () => ({
    FONT: { size: { xs: '12px', sm: '14px' } },
    SIZE: { xs: 12, sm: 14 },
}));

import { toast, ToastPortal, useToast } from '../components/Toast';

afterEach(() => {
    act(() => {
        toast.clear();
    });
    vi.useRealTimers();
});

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

    it('dismisses an indefinite loading toast by id', () => {
        render(<ToastPortal />);

        let id = 0;
        act(() => {
            id = toast.loading('Plotting route…');
        });
        expect(screen.getByText('Plotting route…')).toBeInTheDocument();

        act(() => {
            toast.dismiss(id);
        });
        expect(screen.queryByText('Plotting route…')).not.toBeInTheDocument();
    });

    it('uses the action label as its accessible name and closes after one activation', () => {
        vi.useFakeTimers();
        const onUndo = vi.fn();
        render(<ToastPortal />);

        act(() => {
            toast.success('Waypoint removed', { label: 'Undo', onClick: onUndo });
        });

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(onUndo).toHaveBeenCalledTimes(1);

        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(screen.queryByText('Waypoint removed')).not.toBeInTheDocument();
    });

    it('does not reset an existing toast timer when another toast arrives', () => {
        vi.useFakeTimers();
        render(<ToastPortal />);

        act(() => {
            toast.info('First message', 1000);
        });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        act(() => {
            toast.info('Second message', 3000);
        });
        act(() => {
            vi.advanceTimersByTime(800);
        });

        expect(screen.queryByText('First message')).not.toBeInTheDocument();
        expect(screen.getByText('Second message')).toBeInTheDocument();
    });
});

describe('useToast compatibility API', () => {
    it('returns the emitted id and can hide the matching global toast', () => {
        render(<ToastPortal />);
        const { result } = renderHook(() => useToast());

        let id = 0;
        act(() => {
            id = result.current.showToast('Legacy message');
        });
        expect(screen.getByText('Legacy message')).toBeInTheDocument();

        act(() => {
            result.current.hideToast(id);
        });
        expect(screen.queryByText('Legacy message')).not.toBeInTheDocument();
    });
});
