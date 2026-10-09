/**
 * Trip · Legs is the only door to legs 2 and up from Plan, and its sheet is a
 * lazy chunk (126-16a). React.lazy keeps a rejected import for good, so after
 * one failed load (a web deploy moved the chunk, or the first tap had no
 * signal) every later tap failed at once with the same "Try again in a
 * moment" toast, until the app was reloaded. The door now tries the import
 * again on the next tap. Review finding, 2026-10-09.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({ failuresLeft: 0, loads: 0, toastError: vi.fn() }));

vi.mock('../components/passage/TripSheet', () => {
    h.loads += 1;
    if (h.failuresLeft > 0) {
        h.failuresLeft -= 1;
        throw new Error('Failed to fetch dynamically imported module: TripSheet-old.js');
    }
    return {
        default: () => (
            <div role="dialog" aria-label="Your trips">
                Your trips
            </div>
        ),
    };
});
vi.mock('../components/Toast', () => ({ toast: { error: h.toastError, success: vi.fn(), info: vi.fn() } }));

import { LazyTripSheet } from '../components/passage/LazyTripSheet';

beforeEach(() => {
    setAuthIdentityScope('account-a');
});

describe('the Trip sheet door after a failed chunk load', () => {
    it('says so, closes, and the next tap loads the sheet', async () => {
        // React (and jsdom) report the caught error; it is the point here.
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        const swallow = (event: ErrorEvent) => event.preventDefault();
        window.addEventListener('error', swallow);
        h.failuresLeft = 1;
        const scope = getAuthIdentityScope();

        const firstClose = vi.fn();
        const first = render(<LazyTripSheet scope={scope} onClose={firstClose} onOpenChart={vi.fn()} />);
        await waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
        expect(h.toastError).toHaveBeenCalledWith("Trip · Legs didn't open. Try again in a moment.");
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        first.unmount();

        // The signal is back: the next tap opens it.
        const secondClose = vi.fn();
        render(<LazyTripSheet scope={scope} onClose={secondClose} onOpenChart={vi.fn()} />);
        expect(await screen.findByRole('dialog', { name: 'Your trips' })).toBeInTheDocument();
        expect(secondClose).not.toHaveBeenCalled();
        expect(h.toastError).toHaveBeenCalledOnce();
        expect(h.loads).toBe(2);
        window.removeEventListener('error', swallow);
        quiet.mockRestore();
    });
});
