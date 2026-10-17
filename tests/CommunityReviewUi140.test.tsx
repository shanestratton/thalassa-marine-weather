import React from 'react';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn(), request: vi.fn(), save: vi.fn(), photo: vi.fn(), prepare: vi.fn() }));
vi.mock('../services/community/PlaceReviewsService', () => ({
    listPlaceReviews: api.list,
    reviewsRequest: api.request,
    savePlaceReview: api.save,
    photoRequest: api.photo,
    prepareReviewPhoto: api.prepare,
}));
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, title }: { children: React.ReactNode; title: string }) => (
        <div role="dialog" aria-label={title}>
            {children}
        </div>
    ),
}));
import PlaceReviewsSheet from '../components/community/PlaceReviewsSheet';
import PlaceReviewModeration from '../components/admin/PlaceReviewModeration';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const place = { id: 'osm-node123', name: 'Test marina', kind: 'marina' as const };
const review = {
    id: 'review-id',
    notes: 'Local skipper observation <script>not HTML</script>',
    holding: 'good',
    protection: ['NW'],
    swell: 'some',
    facilities: ['water'],
    visited: '2026-10-01',
    updated_at: '2026-10-17',
    reviewed: false,
    photo_id: null,
    revision: 'rev',
};
beforeEach(() => {
    setAuthIdentityScope('community-ui-a');
    api.list.mockReset().mockResolvedValue([review]);
    api.request.mockReset().mockResolvedValue(null);
    api.save.mockReset().mockResolvedValue({ id: 'saved', revision: 'saved-rev' });
    api.photo.mockReset();
    api.prepare.mockReset();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('actual community review UI controls', () => {
    it('shows indicative observations as text and never makes a navigation claim', async () => {
        render(<PlaceReviewsSheet place={place} onClose={vi.fn()} />);
        await screen.findByText(review.notes);
        expect(document.querySelector('script')).toBeNull();
        expect(screen.getByText(/do not establish holding/)).toBeInTheDocument();
        expect(screen.getByText('Holding: good · Swell: some')).toBeInTheDocument();
    });
    it('submits all fields only after content terms and retains owner revision', async () => {
        api.request.mockImplementation(async (action: string) =>
            action === 'mine' ? { ...review, status: 'visible' } : null,
        );
        render(<PlaceReviewsSheet place={place} onClose={vi.fn()} />);
        await screen.findByText('My note · visible');
        fireEvent.click(screen.getByText('Edit my note'));
        expect(screen.getByText('Save note')).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Your observations'), { target: { value: 'My own new observation.' } });
        fireEvent.click(screen.getByLabelText(/I own or have permission/));
        fireEvent.click(screen.getByText('Save note'));
        await waitFor(() => expect(api.save).toHaveBeenCalled());
        expect(api.save.mock.calls[0].slice(0, 3)).toEqual([
            place,
            expect.objectContaining({
                notes: 'My own new observation.',
                holding: 'good',
                protection: ['NW'],
                swell: 'some',
                facilities: ['water'],
                terms_version: '2026-10-17',
            }),
            'rev',
        ]);
    });
    it('report and contributor block use only review identity, immediately withdraw old UI', async () => {
        render(<PlaceReviewsSheet place={place} onClose={vi.fn()} />);
        await screen.findByText(review.notes);
        fireEvent.change(screen.getByLabelText('Report this note'), { target: { value: 'privacy' } });
        expect(screen.queryByText(review.notes)).toBeNull();
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'report',
                { id: review.id, reason: 'privacy' },
                expect.any(AbortSignal),
            ),
        );
    });
    it('a late old place response cannot reappear after close/account change', async () => {
        let resolve!: (r: (typeof review)[]) => void;
        api.list.mockReturnValue(new Promise((r) => (resolve = r)));
        const close = vi.fn();
        render(<PlaceReviewsSheet place={place} onClose={close} />);
        act(() => setAuthIdentityScope('community-ui-b'));
        expect(close).toHaveBeenCalled();
        await act(async () => resolve([review]));
        expect(screen.queryByText(review.notes)).toBeNull();
    });
    it('moderator decisions carry exact text and photo revisions', async () => {
        api.request.mockImplementation(async (action: string) =>
            action === 'queue'
                ? {
                      queue: [
                          {
                              ...review,
                              place_id: place.id,
                              status: 'held',
                              reason: 'report',
                              photo_id: null,
                              photo_revision: 'photo-rev',
                          },
                      ],
                  }
                : { ok: true },
        );
        render(<PlaceReviewModeration />);
        await screen.findByText(review.notes);
        fireEvent.click(screen.getByText('Remove note'));
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'moderate',
                { id: review.id, revision: 'rev', photo_id: null, photo_revision: 'photo-rev', decision: 'remove' },
                expect.any(AbortSignal),
            ),
        );
    });
    it('backend absence is explicit and does not display invented empty-success', async () => {
        api.list.mockRejectedValue(new Error('Community notes unavailable. Reload and try again.'));
        render(<PlaceReviewsSheet place={place} onClose={vi.fn()} />);
        await screen.findByText('Community notes unavailable. Reload and try again.');
        expect(screen.queryByText(/Latest 12 notes/)).toBeNull();
    });
});
