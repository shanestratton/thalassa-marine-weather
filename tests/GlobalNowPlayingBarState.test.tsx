import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const music = vi.hoisted(() => ({
    getNowPlaying: vi.fn(),
    getMusicPlaybackRevision: vi.fn(() => 0),
    subscribeMusicStopped: vi.fn((_listener: () => void) => () => undefined),
    getAuthorizationStatus: vi.fn(async () => ({ granted: true })),
    pauseMusic: vi.fn(),
    resumeMusic: vi.fn(),
    stopMusic: vi.fn(),
}));
vi.mock('../services/voice/integrations/appleMusic', () => music);
vi.mock('../services/musicEngagement', () => ({
    isMusicEngaged: () => true,
    subscribeMusicEngagement: () => () => undefined,
}));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ currentView: 'dashboard', setPage: vi.fn() }) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../hooks/useDraggablePill', () => ({
    useDraggablePill: () => ({
        ref: { current: null },
        position: null,
        dragging: false,
        consumedTap: () => false,
        handlers: {},
    }),
}));

import { GlobalNowPlayingBar } from '../components/music/GlobalNowPlayingBar';

const TRACK = {
    title: 'Sea Song',
    artist: 'The Crew',
    album: '',
    artworkUrl: '',
    state: 'playing',
    isPlaying: true,
    playbackTime: 43,
    duration: 184,
};

async function renderBar() {
    await act(async () => {
        render(<GlobalNowPlayingBar />);
    });
    expect(screen.getByText(TRACK.title)).toBeInTheDocument();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    music.getMusicPlaybackRevision.mockReturnValue(0);
    music.getNowPlaying.mockResolvedValue(TRACK);
    music.stopMusic.mockResolvedValue({ content: JSON.stringify({ status: 'stopped' }), isError: false });
});
afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('global Apple Music transport state', () => {
    it.each([true, false])(
        'keeps confirmed transport state when a poll wins the action response race (initially playing=%s)',
        async (initiallyPlaying) => {
            music.getNowPlaying.mockResolvedValue({ ...TRACK, isPlaying: initiallyPlaying });
            const command = initiallyPlaying ? music.pauseMusic : music.resumeMusic;
            let finish!: (result: { content: string; isError: boolean }) => void;
            command.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            await renderBar();
            fireEvent.click(screen.getByRole('button', { name: initiallyPlaying ? 'Pause' : 'Play' }));
            music.getNowPlaying.mockResolvedValue({ ...TRACK, isPlaying: !initiallyPlaying });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(initiallyPlaying ? 2000 : 8000);
            });
            const resultingLabel = initiallyPlaying ? 'Play' : 'Pause';
            expect(screen.getByRole('button', { name: resultingLabel })).toBeDisabled();
            await act(async () => {
                finish({
                    content: JSON.stringify({ status: initiallyPlaying ? 'paused' : 'playing' }),
                    isError: false,
                });
            });
            expect(screen.getByRole('button', { name: resultingLabel })).toBeEnabled();
        },
    );

    it.each(['no_queue', 'failed', 'superseded'])(
        'does not claim playback for an unconfirmed resume: %s',
        async (status) => {
            music.getNowPlaying.mockResolvedValue({ ...TRACK, isPlaying: false });
            music.resumeMusic.mockResolvedValueOnce({ content: JSON.stringify({ status }), isError: false });
            await renderBar();
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Play' }));
            });
            expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
        },
    );

    it('hides only after confirmed Stop and can show the same song after a deliberate replay', async () => {
        await renderBar();
        music.stopMusic.mockResolvedValueOnce({ content: 'Unable to stop', isError: true });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Stop and dismiss now playing' }));
        });
        expect(screen.getByText(TRACK.title)).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Stop and dismiss now playing' }));
        });
        expect(screen.queryByText(TRACK.title)).not.toBeInTheDocument();
        // The bridge's next explicit playback intent permits this same title;
        // the bar must not retain its old title-based dismissal suppression.
        music.getMusicPlaybackRevision.mockReturnValue(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByText(TRACK.title)).toBeInTheDocument();
    });

    it('ignores a pre-Stop poll after a confirmed Stop from another music surface', async () => {
        await renderBar();
        let finish!: (track: typeof TRACK) => void;
        music.getNowPlaying.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        await act(async () => {
            music.getMusicPlaybackRevision.mockReturnValue(1);
            music.subscribeMusicStopped.mock.calls[0][0]();
            finish(TRACK);
        });
        expect(screen.queryByText(TRACK.title)).not.toBeInTheDocument();
    });
});
