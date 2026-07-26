import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const music = vi.hoisted(() => ({
    getUserPlaylists: vi.fn(),
    playPlaylist: vi.fn(),
    pauseMusic: vi.fn(),
    resumeMusic: vi.fn(),
    skipNext: vi.fn(),
    skipPrevious: vi.fn(),
    getNowPlaying: vi.fn(),
    requestAuthorization: vi.fn(),
    getAuthorizationStatus: vi.fn(),
    getPlaylistTracks: vi.fn(),
    playTrackInPlaylist: vi.fn(),
    createPlaylistByName: vi.fn(),
    searchCatalogSongs: vi.fn(),
    addSongToPlaylist: vi.fn(),
    deletePlaylistById: vi.fn(),
}));

vi.mock('../services/voice/integrations/appleMusic', () => music);
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../services/musicEngagement', () => ({ markMusicEngaged: vi.fn() }));
vi.mock('@capacitor/keyboard', () => ({
    Keyboard: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    },
}));

import { MusicPage } from '../components/music/MusicPage';

const PLAYLIST = {
    id: 'playlist-1',
    name: 'Harbour Mix',
    curator: 'Skipper Shane',
    artworkUrl: '',
    previewTracks: [{ title: 'Sea Song', artist: 'The Crew' }],
};

const TRACKS = [
    {
        id: 'track-1',
        title: 'Sea Song',
        artist: 'The Crew',
        durationMs: 184_000,
        artworkUrl: '',
    },
];

async function renderMusicPage() {
    render(<MusicPage onBack={vi.fn()} />);
    return screen.findByRole('button', { name: /^Harbour Mix$/i });
}

async function openPlaylistDetails() {
    const tile = await renderMusicPage();
    tile.focus();
    fireEvent.mouseDown(tile);
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 510));
    });
    fireEvent.mouseUp(tile);
    return { tile, dialog: await screen.findByRole('dialog', { name: 'Harbour Mix' }) };
}

function expectModalBodyPortal(element: HTMLElement) {
    const portal = element.closest<HTMLElement>('[data-overlay-layer="modal"]');
    expect(portal?.parentElement).toBe(document.body);
    expect(portal).toHaveStyle({ zIndex: '1100' });
}

describe('MusicPage modal accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        music.getAuthorizationStatus.mockResolvedValue({ granted: true, status: 'authorized' });
        music.getUserPlaylists.mockResolvedValue({ available: true, playlists: [PLAYLIST] });
        music.getPlaylistTracks.mockResolvedValue({
            available: true,
            name: PLAYLIST.name,
            tracks: TRACKS,
        });
        music.getNowPlaying.mockResolvedValue(null);
        music.playPlaylist.mockResolvedValue({ success: true });
        music.playTrackInPlaylist.mockResolvedValue({ success: true });
        music.createPlaylistByName.mockResolvedValue({ success: true });
        music.searchCatalogSongs.mockResolvedValue({ available: true, songs: [] });
        music.addSongToPlaylist.mockResolvedValue({ success: true });
        music.deletePlaylistById.mockResolvedValue({ success: false, notSupported: true });
    });

    it('contains focus across nested playlist overlays and restores each launcher', async () => {
        const { tile, dialog } = await openPlaylistDetails();
        const closeDetails = screen.getByRole('button', {
            name: 'Close Harbour Mix playlist details',
        });
        expect(closeDetails).toHaveFocus();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expectModalBodyPortal(dialog);

        expect(
            await screen.findByRole('button', {
                name: 'Play track 1: Sea Song by The Crew',
            }),
        ).toBeInTheDocument();

        const addTracks = screen.getByRole('button', { name: 'Add tracks to Harbour Mix' });
        addTracks.focus();
        fireEvent.click(addTracks);

        const search = await screen.findByRole('textbox', { name: 'Search Apple Music catalog' });
        const addTracksDialog = screen.getByRole('dialog', { name: 'Add tracks' });
        expect(addTracksDialog).toHaveAccessibleDescription('to "Harbour Mix"');
        expectModalBodyPortal(addTracksDialog);
        expect(screen.queryByRole('dialog', { name: 'Harbour Mix' })).not.toBeInTheDocument();
        expect(search).toHaveFocus();

        const backToDetails = screen.getByRole('button', {
            name: 'Back to Harbour Mix playlist details',
        });
        fireEvent.keyDown(search, { key: 'Tab' });
        expect(backToDetails).toHaveFocus();
        search.focus();
        fireEvent.keyDown(search, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add tracks' })).not.toBeInTheDocument());
        expect(addTracks).toHaveFocus();

        const deletePlaylist = screen.getByRole('button', { name: 'Delete Harbour Mix playlist' });
        deletePlaylist.focus();
        fireEvent.click(deletePlaylist);

        const alert = await screen.findByRole('alertdialog', { name: 'Delete in Apple Music' });
        const cancelDelete = screen.getByRole('button', {
            name: 'Cancel deleting Harbour Mix playlist',
        });
        expect(alert).toHaveAccessibleDescription(/remove "Harbour Mix"/);
        expectModalBodyPortal(alert);
        expect(screen.queryByRole('dialog', { name: 'Harbour Mix' })).not.toBeInTheDocument();
        expect(cancelDelete).toHaveFocus();

        fireEvent.keyDown(cancelDelete, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(deletePlaylist).toHaveFocus();

        fireEvent.keyDown(deletePlaylist, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Harbour Mix' })).not.toBeInTheDocument());
        expect(tile).toHaveFocus();
    });

    it('labels the create-playlist dialog, traps focus, and restores the header action', async () => {
        await renderMusicPage();
        const opener = screen.getByRole('button', { name: 'Create playlist' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole('dialog', { name: 'New playlist' });
        const name = screen.getByRole('textbox', { name: 'Playlist name' });
        expect(dialog).toHaveAccessibleDescription(/Give it a name/);
        expectModalBodyPortal(dialog);
        expect(name).toHaveFocus();

        fireEvent.change(name, { target: { value: 'Night Watch' } });
        const create = screen.getByRole('button', { name: 'Create new playlist' });
        create.focus();
        fireEvent.keyDown(create, { key: 'Tab' });
        expect(name).toHaveFocus();

        fireEvent.keyDown(name, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New playlist' })).not.toBeInTheDocument());
        expect(opener).toHaveFocus();
    });

    it('offers an explicit playlist-options action for keyboard and switch users', async () => {
        await renderMusicPage();

        const options = screen.getByRole('button', { name: 'More options for Harbour Mix' });
        expect(options).toHaveClass('h-11', 'w-11');
        options.focus();
        fireEvent.keyDown(options, { key: 'Enter' });
        fireEvent.click(options);

        expect(await screen.findByRole('dialog', { name: 'Harbour Mix' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close Harbour Mix playlist details' })).toHaveFocus();
    });

    it('keeps playlist-preview hydration capped at two MusicKit calls across refreshes', async () => {
        const playlists = Array.from({ length: 4 }, (_, index) => ({
            ...PLAYLIST,
            id: `playlist-${index + 1}`,
            name: `Watch ${index + 1}`,
        }));
        const pending: Array<() => void> = [];
        let activeCalls = 0;
        let peakCalls = 0;

        music.getUserPlaylists.mockResolvedValue({ available: true, playlists });
        music.getPlaylistTracks.mockImplementation(
            (id: string) =>
                new Promise((resolve) => {
                    activeCalls += 1;
                    peakCalls = Math.max(peakCalls, activeCalls);
                    pending.push(() => {
                        activeCalls -= 1;
                        resolve({
                            available: true,
                            name: id,
                            tracks: [{ ...TRACKS[0], id: `track-${id}` }],
                        });
                    });
                }),
        );

        render(<MusicPage onBack={vi.fn()} />);
        await screen.findByRole('button', { name: /^Watch 1$/i });
        await waitFor(() => expect(music.getPlaylistTracks).toHaveBeenCalledTimes(2));
        expect(peakCalls).toBe(2);

        const refresh = screen.getByRole('button', { name: 'Refresh Apple Music library' });
        await waitFor(() => expect(refresh).not.toBeDisabled());
        fireEvent.click(refresh);
        await waitFor(() => expect(music.getUserPlaylists).toHaveBeenCalledTimes(2));

        // The second response replaces queued jobs, but must wait for the
        // two first-generation native calls to release their shared slots.
        await waitFor(() => expect(music.getPlaylistTracks).toHaveBeenCalledTimes(2));
        expect(peakCalls).toBe(2);

        await act(async () => {
            pending.shift()?.();
            pending.shift()?.();
        });
        await waitFor(() => expect(music.getPlaylistTracks).toHaveBeenCalledTimes(4));
        expect(peakCalls).toBe(2);

        await act(async () => {
            pending.splice(0).forEach((resolve) => resolve());
        });
    });

    it('ignores an older library response after a newer refresh has painted the grid', async () => {
        const responses: Array<(result: { available: boolean; playlists: (typeof PLAYLIST)[] }) => void> = [];
        music.getUserPlaylists.mockImplementation(
            () =>
                new Promise((resolve) => {
                    responses.push(resolve);
                }),
        );
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

        try {
            render(<MusicPage onBack={vi.fn()} />);
            await waitFor(() => expect(music.getUserPlaylists).toHaveBeenCalledTimes(1));

            fireEvent(document, new Event('visibilitychange'));
            await waitFor(() => expect(music.getUserPlaylists).toHaveBeenCalledTimes(2));

            const current = { ...PLAYLIST, id: 'current-library', name: 'Current Library' };
            await act(async () => {
                responses[1]({ available: true, playlists: [current] });
            });
            expect(await screen.findByRole('button', { name: /^Current Library$/i })).toBeInTheDocument();

            const stale = { ...PLAYLIST, id: 'stale-library', name: 'Stale Library' };
            await act(async () => {
                responses[0]({ available: true, playlists: [stale] });
            });

            expect(screen.getByRole('button', { name: /^Current Library$/i })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /^Stale Library$/i })).not.toBeInTheDocument();
        } finally {
            visibility.mockRestore();
        }
    });

    it('keeps the refresh action busy while the newest library request is still pending', async () => {
        const responses: Array<(result: { available: boolean; playlists: (typeof PLAYLIST)[] }) => void> = [];
        music.getUserPlaylists.mockImplementation(
            () =>
                new Promise((resolve) => {
                    responses.push(resolve);
                }),
        );
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

        try {
            render(<MusicPage onBack={vi.fn()} />);
            await waitFor(() => expect(music.getUserPlaylists).toHaveBeenCalledTimes(1));

            fireEvent(document, new Event('visibilitychange'));
            await waitFor(() => expect(music.getUserPlaylists).toHaveBeenCalledTimes(2));

            await act(async () => {
                responses[0]({ available: true, playlists: [{ ...PLAYLIST, name: 'Old Library' }] });
            });

            const refresh = screen.getByRole('button', { name: 'Refresh Apple Music library' });
            expect(refresh).toBeDisabled();
            expect(screen.queryByRole('button', { name: /^Old Library$/i })).not.toBeInTheDocument();

            await act(async () => {
                responses[1]({ available: true, playlists: [{ ...PLAYLIST, name: 'Latest Library' }] });
            });

            expect(await screen.findByRole('button', { name: /^Latest Library$/i })).toBeInTheDocument();
            await waitFor(() => expect(refresh).not.toBeDisabled());
        } finally {
            visibility.mockRestore();
        }
    });

    it('keeps a confirmed new playlist visible while Apple Music library sync catches up', async () => {
        music.createPlaylistByName.mockResolvedValue({
            success: true,
            id: 'created-night-watch',
            name: 'Night Watch',
        });

        await renderMusicPage();
        fireEvent.click(screen.getByRole('button', { name: 'Create playlist' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Playlist name' }), {
            target: { value: 'Night Watch' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create new playlist' }));

        // The mocked next library response still contains only Harbour Mix;
        // the confirmed create must not disappear while iCloud catches up.
        expect(await screen.findByRole('button', { name: /^Night Watch$/i })).toBeInTheDocument();
    });

    it('guides denied Apple Music access to iOS Settings instead of offering a dead-end retry', async () => {
        music.getAuthorizationStatus.mockResolvedValue({ granted: false, status: 'denied' });

        render(<MusicPage onBack={vi.fn()} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Apple Music is turned off');
        expect(screen.getByRole('button', { name: 'Open Music settings' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Connect Apple Music' })).not.toBeInTheDocument();
    });
});
