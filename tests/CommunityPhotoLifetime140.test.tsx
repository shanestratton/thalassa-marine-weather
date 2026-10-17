import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ photo: vi.fn() }));
vi.mock('../services/community/PlaceReviewsService', () => ({ photoRequest: api.photo }));
import { ReviewPhoto } from '../components/community/ReviewPhoto';
import { setAuthIdentityScope } from '../services/authIdentityScope';
beforeEach(() => {
    setAuthIdentityScope('photo-a');
    api.photo.mockReset().mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('photo demand and resource lifetime', () => {
    it('loads no photo until requested and retires the previous image request when another opens', () => {
        render(
            <>
                <ReviewPhoto id="a" />
                <ReviewPhoto id="b" />
            </>,
        );
        expect(api.photo).not.toHaveBeenCalled();
        fireEvent.click(screen.getAllByText('View photo')[0]);
        expect(api.photo).toHaveBeenCalledTimes(1);
        const first = api.photo.mock.calls[0][1] as AbortSignal;
        expect(first.aborted).toBe(false);
        fireEvent.click(screen.getByText('View photo'));
        expect(api.photo).toHaveBeenCalledTimes(2);
        expect(first.aborted).toBe(true);
        expect((api.photo.mock.calls[1][1] as AbortSignal).aborted).toBe(false);
    });
    it('retires immediately on auth change or sheet unmount', () => {
        const view = render(<ReviewPhoto id="a" />);
        fireEvent.click(screen.getByText('View photo'));
        const first = api.photo.mock.calls[0][1] as AbortSignal;
        act(() => setAuthIdentityScope('photo-b'));
        expect(first.aborted).toBe(true);
        expect(screen.getByText('View photo')).toBeInTheDocument();
        fireEvent.click(screen.getByText('View photo'));
        const second = api.photo.mock.calls[1][1] as AbortSignal;
        view.unmount();
        expect(second.aborted).toBe(true);
    });
    it('bounds an ignored or pending image read to fifteen seconds', () => {
        vi.useFakeTimers();
        render(<ReviewPhoto id="a" />);
        fireEvent.click(screen.getByText('View photo'));
        const signal = api.photo.mock.calls[0][1] as AbortSignal;
        act(() => vi.advanceTimersByTime(15000));
        expect(signal.aborted).toBe(true);
        expect(screen.getByText('View photo')).toBeInTheDocument();
    });
});
