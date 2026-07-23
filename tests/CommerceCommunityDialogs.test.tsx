import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const bgGeoMocks = vi.hoisted(() => ({
    getLastPosition: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/TrackSharingService', () => ({
    TrackSharingService: {
        browseSharedTracks: vi.fn().mockResolvedValue({ tracks: [], total: 0 }),
        getDistinctRegions: vi.fn().mockResolvedValue([]),
        getMySharedTracks: vi.fn().mockResolvedValue([]),
        deleteSharedTrack: vi.fn().mockResolvedValue(true),
        downloadTrack: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getLogEntries: vi.fn().mockResolvedValue([]),
        importGPXVoyage: vi.fn().mockResolvedValue({ savedCount: 0 }),
    },
}));
vi.mock('../services/gpxService', () => ({ importGPXToEntries: vi.fn().mockReturnValue([]) }));
vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: { getLastPosition: bgGeoMocks.getLastPosition },
}));

import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';
import { CrewModals } from '../components/crew-finder/CrewModals';
import { CreateListingModal } from '../components/marketplace/CreateListingModal';
import type { CrewFinderState } from '../hooks/useCrewFinderState';

describe('commerce and community dialogs', () => {
    it('contains the full-screen community browser and restores its opener', async () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Browse community tracks</button>
                <CommunityTrackBrowser isOpen={false} onClose={onClose} onImportComplete={vi.fn()} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Browse community tracks' });
        opener.focus();

        rerender(
            <>
                <button>Browse community tracks</button>
                <CommunityTrackBrowser isOpen onClose={onClose} onImportComplete={vi.fn()} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close dialog' });
        await waitFor(() => expect(close).toHaveFocus());
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Browse community tracks</button>
                <CommunityTrackBrowser isOpen={false} onClose={onClose} onImportComplete={vi.fn()} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('resets a cancelled marketplace draft regardless of how it is dismissed', () => {
        const onClose = vi.fn();
        const { rerender } = render(<CreateListingModal isOpen onClose={onClose} onCreated={vi.fn()} />);
        const cancel = screen.getByRole('button', { name: 'Close create listing form' });
        expect(cancel).toHaveFocus();
        const title = screen.getByRole('textbox', { name: 'Title' });
        fireEvent.change(title, { target: { value: 'Used anchor' } });
        expect(title).toHaveValue('Used anchor');

        fireEvent.keyDown(title, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
        rerender(<CreateListingModal isOpen={false} onClose={onClose} onCreated={vi.fn()} />);
        rerender(<CreateListingModal isOpen onClose={onClose} onCreated={vi.fn()} />);
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    });

    it('ignores a late reverse-geocode result after the listing is dismissed', async () => {
        bgGeoMocks.getLastPosition.mockReturnValueOnce({ latitude: -27.47, longitude: 153.03 }).mockReturnValue(null);
        let resolveFetch!: (value: { json: () => Promise<unknown> }) => void;
        const fetchMock = vi.fn(
            () =>
                new Promise<{ json: () => Promise<unknown> }>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const onClose = vi.fn();

        try {
            const { rerender } = render(<CreateListingModal isOpen onClose={onClose} onCreated={vi.fn()} />);
            fireEvent.keyDown(screen.getByRole('button', { name: 'Close create listing form' }), { key: 'Escape' });
            rerender(<CreateListingModal isOpen={false} onClose={onClose} onCreated={vi.fn()} />);

            resolveFetch({
                json: () =>
                    Promise.resolve({
                        address: { country: 'Australia', state: 'Queensland', suburb: 'Brisbane' },
                    }),
            });
            await Promise.resolve();
            await Promise.resolve();

            rerender(<CreateListingModal isOpen onClose={onClose} onCreated={vi.fn()} />);
            expect(screen.getByRole('textbox', { name: 'Country' })).toHaveValue('');
            expect(screen.getByRole('textbox', { name: 'State' })).toHaveValue('');
            expect(screen.getByRole('textbox', { name: 'Suburb' })).toHaveValue('');
        } finally {
            vi.unstubAllGlobals();
            bgGeoMocks.getLastPosition.mockReturnValue(null);
        }
    });

    it('revokes photo preview URLs when a listing draft is discarded', () => {
        const createObjectURL = vi.fn().mockReturnValue('blob:listing-photo');
        const revokeObjectURL = vi.fn();
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

        try {
            const { container } = render(<CreateListingModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
            const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
            expect(fileInput).not.toBeNull();
            fireEvent.change(fileInput!, {
                target: { files: [new File(['photo'], 'anchor.jpg', { type: 'image/jpeg' })] },
            });
            expect(createObjectURL).toHaveBeenCalledOnce();

            fireEvent.click(screen.getByRole('button', { name: 'Close create listing form' }));
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:listing-photo');
        } finally {
            Object.defineProperty(URL, 'createObjectURL', {
                configurable: true,
                value: originalCreateObjectURL,
            });
            Object.defineProperty(URL, 'revokeObjectURL', {
                configurable: true,
                value: originalRevokeObjectURL,
            });
        }
    });

    it('keeps crew-report focus on the safe cancel action and handles Escape', () => {
        const dispatch = vi.fn();
        const state = {
            showDeleteConfirm: false,
            showReportModal: 'user-1',
            showSuperLikeModal: null,
            reportReason: '',
            superLikeMessage: '',
            deleting: false,
        } as CrewFinderState;
        render(
            <CrewModals
                state={state}
                dispatch={dispatch}
                onReport={vi.fn()}
                onSuperLike={vi.fn()}
                onDeleteProfile={vi.fn()}
            />,
        );
        const cancel = screen.getByRole('button', { name: 'Cancel report' });
        expect(screen.getByRole('dialog', { name: '🚩 Report User' })).toContainElement(cancel);
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SHOW_REPORT_MODAL', payload: null });
    });
});
