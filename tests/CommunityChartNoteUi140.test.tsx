import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ request: vi.fn(), photo: vi.fn(), prepare: vi.fn() }));
vi.mock('../services/community/ChartNotesService', () => ({
    chartNotesRequest: api.request,
    chartPhotoRequest: api.photo,
    CHART_NOTES_CHANGED: 'fixture:chart-notes-changed',
}));
vi.mock('../services/community/PlaceReviewsService', () => ({
    prepareReviewPhoto: api.prepare,
    photoRequest: vi.fn(),
}));
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({
        children,
        title,
        footer,
    }: {
        children: React.ReactNode;
        title: string;
        footer?: React.ReactNode;
    }) => (
        <div role="dialog" aria-label={title}>
            {children}
            {footer}
        </div>
    ),
}));
import ChartNoteSheet from '../components/community/ChartNoteSheet';
import ChartNoteModeration from '../components/admin/ChartNoteModeration';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { ChartNote } from '../services/community/chartNotesModel';
const note: ChartNote = {
    id: '10000000-0000-4000-8000-000000000001',
    revision: '20000000-0000-4000-8000-000000000001',
    kind: 'hazard',
    latitude: -27,
    longitude: 153,
    message: 'Unofficial <script>plain text</script>',
    observed_date: '2026-10-17',
    expires_at: '2026-11-16T00:00:00Z',
    confirms: 1,
    denies: 0,
    my_vote: null,
    mine: false,
    reviewed: false,
    photo_id: null,
};
const pin = { lat: -27, lon: 153 };
beforeEach(() => {
    setAuthIdentityScope('ui-a');
    api.request.mockReset().mockResolvedValue(null);
    api.photo.mockReset();
    api.prepare.mockReset();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('actual unofficial note editor and controls', () => {
    it('publishes the deliberately chosen map pin only after separate consent', async () => {
        api.request.mockResolvedValue({ id: note.id, revision: note.revision, status: 'visible' });
        render(<ChartNoteSheet pin={pin} onClose={vi.fn()} />);
        expect(screen.getByText(/Public pin: -27.00000, 153.00000/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Observation'), {
            target: { value: 'My deliberate public observation.' },
        });
        fireEvent.click(screen.getByText('Publish pin and note'));
        expect(api.request).not.toHaveBeenCalled();
        fireEvent.click(screen.getByLabelText(/I choose to publish this pin/));
        fireEvent.click(screen.getByText('Publish pin and note'));
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'save',
                expect.objectContaining({
                    latitude: -27,
                    longitude: 153,
                    message: 'My deliberate public observation.',
                    public_consent: 'publish-pin-and-note-v1',
                    terms_version: '2026-10-17',
                }),
                expect.any(AbortSignal),
            ),
        );
        expect(api.request.mock.calls[0][1]).not.toHaveProperty('vessel_id');
    });
    it('renders text safely, keeps unofficial wording, and votes against the exact revision', async () => {
        render(<ChartNoteSheet note={note} pin={pin} onClose={vi.fn()} />);
        expect(screen.getByText(note.message)).toBeInTheDocument();
        expect(document.querySelector('script')).toBeNull();
        expect(screen.getByText(/do not update official charts/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'vote',
                { id: note.id, revision: note.revision, choice: 'confirm' },
                expect.any(AbortSignal),
            ),
        );
        expect(screen.queryByText(note.message)).toBeNull();
    });
    it('withdraws details on exact source retirement, report event and auth transition', () => {
        const close = vi.fn();
        const view = render(<ChartNoteSheet note={note} pin={pin} onClose={close} />);
        view.rerender(<ChartNoteSheet pin={pin} retired onClose={close} />);
        expect(screen.queryByText(note.message)).toBeNull();
        view.rerender(<ChartNoteSheet note={note} pin={pin} onClose={close} />);
        act(() => window.dispatchEvent(new Event('fixture:chart-notes-changed')));
        expect(screen.queryByText(note.message)).toBeNull();
        act(() => setAuthIdentityScope('ui-b'));
        expect(close).toHaveBeenCalled();
    });
    it('rechecks owned content before editing and retains the server revision', async () => {
        api.request.mockImplementation(async (action: string) =>
            action === 'mine' ? { note: { ...note, status: 'held' } } : { id: note.id, revision: note.revision },
        );
        render(<ChartNoteSheet note={{ ...note, mine: true }} pin={pin} onClose={vi.fn()} />);
        fireEvent.click(screen.getByText('Edit / remove my note'));
        await screen.findByText('Edits need fresh consent. Held notes still need moderation.');
        expect(api.request).toHaveBeenCalledWith('mine', { id: note.id }, expect.any(AbortSignal));
        fireEvent.click(screen.getByLabelText(/I choose to publish this pin/));
        fireEvent.click(screen.getByText('Publish pin and note'));
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'save',
                expect.objectContaining({ id: note.id, revision: note.revision }),
                expect.any(AbortSignal),
            ),
        );
    });
    it('keeps pending photos on the separate chart path and reports partial photo failure honestly', async () => {
        api.request.mockResolvedValue({ id: note.id, revision: note.revision });
        api.prepare.mockResolvedValue(new Blob(['jpeg']));
        api.photo.mockRejectedValue(Error('unavailable'));
        render(<ChartNoteSheet pin={pin} onClose={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Observation'), { target: { value: 'With photo.' } });
        fireEvent.change(screen.getByLabelText('Optional JPEG photo'), {
            target: { files: [new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' })] },
        });
        fireEvent.click(screen.getByLabelText(/I choose to publish this pin/));
        fireEvent.click(screen.getByText('Publish pin and note'));
        await screen.findByText('Note saved. Photo was not accepted; reopen your note to retry.');
        expect(api.photo).toHaveBeenCalledWith(
            note.id,
            expect.any(AbortSignal),
            expect.objectContaining({ revision: note.revision }),
        );
    });
    it('moderator buttons carry exact note and private photo revisions', async () => {
        const photo = '30000000-0000-4000-8000-000000000001';
        api.request.mockImplementation(async (action: string) =>
            action === 'queue'
                ? {
                      queue: [{ ...note, status: 'held', reason: 'report', photo_id: photo, photo_revision: photo }],
                      server_now: '2026-10-17T00:00:00Z',
                  }
                : { ok: true },
        );
        render(<ChartNoteModeration />);
        fireEvent.click(screen.getByText('Refresh chart queue'));
        await screen.findByText(note.message);
        fireEvent.click(screen.getByText('Approve photo'));
        await waitFor(() =>
            expect(api.request).toHaveBeenCalledWith(
                'moderate',
                {
                    id: note.id,
                    revision: note.revision,
                    photo_id: photo,
                    photo_revision: photo,
                    decision: 'approve-photo',
                },
                expect.any(AbortSignal),
            ),
        );
    });
});
