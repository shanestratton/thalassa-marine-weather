import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const bgGeoMocks = vi.hoisted(() => ({
    getLastPosition: vi.fn().mockReturnValue(null),
}));

vi.mock('../utils/featureVisibility', () => ({
    FEATURE_VISIBILITY: { communityTrackSharing: true },
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
        const dialog = screen.getByRole('dialog', { name: 'Community track browser' });
        const close = screen.getByRole('button', { name: 'Close dialog' });
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog.style.zIndex).toBe('1100');
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
        expect(screen.getByRole('dialog', { name: '🚩 Report profile' })).toContainElement(cancel);
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SHOW_REPORT_MODAL', payload: null });
    });
});
