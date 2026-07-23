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
    return screen.findByRole('button', { name: /Harbour Mix/i });
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

        expect(
            await screen.findByRole('button', {
                name: 'Play track 1: Sea Song by The Crew',
            }),
        ).toBeInTheDocument();

        const addTracks = screen.getByRole('button', { name: 'Add tracks to Harbour Mix' });
        addTracks.focus();
        fireEvent.click(addTracks);

        const search = await screen.findByRole('textbox', { name: 'Search Apple Music catalog' });
        expect(screen.getByRole('dialog', { name: 'Add tracks' })).toHaveAccessibleDescription('to "Harbour Mix"');
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
});
