import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const communityMocks = vi.hoisted(() => ({
    browseSharedTracks: vi.fn(),
    getDistinctRegions: vi.fn(),
    getMySharedTracks: vi.fn(),
    deleteSharedTrack: vi.fn(),
    downloadTrack: vi.fn(),
    getLogEntries: vi.fn(),
    importGPXVoyage: vi.fn(),
    importGPXToEntries: vi.fn(),
}));

vi.mock('../services/TrackSharingService', () => ({
    TrackSharingService: {
        browseSharedTracks: communityMocks.browseSharedTracks,
        getDistinctRegions: communityMocks.getDistinctRegions,
        getMySharedTracks: communityMocks.getMySharedTracks,
        deleteSharedTrack: communityMocks.deleteSharedTrack,
        downloadTrack: communityMocks.downloadTrack,
    },
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getLogEntries: communityMocks.getLogEntries,
        importGPXVoyage: communityMocks.importGPXVoyage,
    },
}));

vi.mock('../services/gpxService', () => ({
    importGPXToEntries: communityMocks.importGPXToEntries,
}));

const track = {
    id: 'shared-track-a',
    user_id: 'publisher',
    title: 'Moreton passage',
    description: 'A sheltered route',
    tags: [],
    category: 'coastal',
    region: 'Queensland',
    center_lat: -27.2,
    center_lon: 153.3,
    distance_nm: 12,
    point_count: 8,
    download_count: 2,
    created_at: '2026-07-23T00:00:00.000Z',
};

import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    communityMocks.browseSharedTracks.mockResolvedValue({ tracks: [track], total: 1 });
    communityMocks.getDistinctRegions.mockResolvedValue(['Queensland']);
    communityMocks.getMySharedTracks.mockResolvedValue([]);
    communityMocks.deleteSharedTrack.mockResolvedValue(true);
    communityMocks.downloadTrack.mockResolvedValue('<gpx />');
    communityMocks.importGPXToEntries.mockReturnValue([{ id: 'entry-1' }]);
    communityMocks.importGPXVoyage.mockResolvedValue({ savedCount: 1 });
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('CommunityTrackBrowser identity handoff', () => {
    it('does not continue an account-A import under account B after the duplicate check resolves', async () => {
        let resolveEntries!: (entries: []) => void;
        communityMocks.getLogEntries.mockReturnValue(
            new Promise<[]>((resolve) => {
                resolveEntries = resolve;
            }),
        );
        render(<CommunityTrackBrowser isOpen onClose={vi.fn()} onImportComplete={vi.fn()} />);

        await screen.findByText('Moreton passage');
        fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
        act(() => {
            setAuthIdentityScope('account-b');
            resolveEntries([]);
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(communityMocks.downloadTrack).not.toHaveBeenCalled();
        expect(communityMocks.importGPXVoyage).not.toHaveBeenCalled();
    });

    it('pins the mutation to its captured account and preserves stable community provenance', async () => {
        communityMocks.getLogEntries.mockResolvedValue([]);
        render(<CommunityTrackBrowser isOpen onClose={vi.fn()} onImportComplete={vi.fn()} />);

        await screen.findByText('Moreton passage');
        const expectedScope = getAuthIdentityScope();
        fireEvent.click(screen.getByRole('button', { name: 'Download file' }));

        await vi.waitFor(() =>
            expect(communityMocks.importGPXVoyage).toHaveBeenCalledWith(
                [{ id: 'entry-1' }],
                expect.objectContaining({
                    expectedScope,
                    source: 'community_download',
                    voyageId: track.id,
                }),
            ),
        );
    });

    it('does not download the same stable community voyage twice', async () => {
        communityMocks.getLogEntries.mockResolvedValue([{ source: 'community_download', voyageId: track.id }]);
        render(<CommunityTrackBrowser isOpen onClose={vi.fn()} onImportComplete={vi.fn()} />);

        await screen.findByText('Moreton passage');
        fireEvent.click(screen.getByRole('button', { name: 'Download file' }));

        await screen.findByText(/Already imported/);
        expect(communityMocks.downloadTrack).not.toHaveBeenCalled();
        expect(communityMocks.importGPXVoyage).not.toHaveBeenCalled();
    });
});
