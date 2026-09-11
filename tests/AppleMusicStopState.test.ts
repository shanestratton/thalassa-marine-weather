import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
    native: {
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        nowPlaying: vi.fn(),
        playPlaylist: vi.fn(),
        playTrackInPlaylist: vi.fn(),
    },
    isNative: vi.fn(() => true),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: bridge.isNative, getPlatform: () => 'ios' },
    registerPlugin: () => bridge.native,
}));

const TRACK = {
    is_playing: true,
    state: 'playing',
    title: 'Sea Song',
    artist: 'The Crew',
    album: 'Harbour',
    artwork_url: 'https://example.invalid/artwork.jpg',
    playback_time: 43,
    duration: 184,
};
let music: typeof import('../services/voice/integrations/appleMusic');
beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    bridge.isNative.mockReturnValue(true);
    bridge.native.stop.mockResolvedValue({ status: 'stopped' });
    bridge.native.pause.mockResolvedValue({ status: 'paused' });
    bridge.native.resume.mockResolvedValue({ status: 'playing' });
    bridge.native.playPlaylist.mockResolvedValue({ status: 'playing', playlist_name: 'Harbour Mix' });
    bridge.native.playTrackInPlaylist.mockResolvedValue({ status: 'playing', title: TRACK.title });
    bridge.native.nowPlaying.mockResolvedValue(TRACK);
    music = await import('../services/voice/integrations/appleMusic');
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('Apple Music confirmed Stop boundary', () => {
    it('suppresses retained metadata after Stop until an explicit new playback intent, including the same song', async () => {
        const stopped = vi.fn();
        const unsubscribe = music.subscribeMusicStopped(stopped);
        expect(await music.getNowPlaying()).toMatchObject({ title: 'Sea Song', isPlaying: true });
        expect((await music.stopMusic()).isError).toBe(false);
        expect(bridge.native.stop).toHaveBeenCalledOnce();
        expect(stopped).toHaveBeenCalledOnce();
        // Native may retain title/artwork while its queue transition settles.
        expect(await music.getNowPlaying()).toBeNull();
        expect((await music.playPlaylist('harbour')).success).toBe(true);
        expect(await music.getNowPlaying()).toMatchObject({ title: 'Sea Song', isPlaying: true });
        unsubscribe();
        await music.stopMusic();
        expect(stopped).toHaveBeenCalledOnce();
    });

    it('keeps paused song metadata and duration; Pause never clears the queue or announces Stop', async () => {
        const stopped = vi.fn();
        music.subscribeMusicStopped(stopped);
        await music.pauseMusic();
        bridge.native.nowPlaying.mockResolvedValue({ ...TRACK, state: 'paused', is_playing: false });
        expect(await music.getNowPlaying()).toMatchObject({
            title: TRACK.title,
            isPlaying: false,
            playbackTime: 43,
            duration: 184,
        });
        expect(bridge.native.stop).not.toHaveBeenCalled();
        expect(stopped).not.toHaveBeenCalled();
    });

    it('discards a pre-Stop now-playing response that resolves after Stop', async () => {
        let finish!: (value: typeof TRACK) => void;
        bridge.native.nowPlaying.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const reading = music.getNowPlaying();
        await music.stopMusic();
        finish(TRACK);
        expect(await reading).toBeNull();
    });

    it.each(['playlist', 'track'] as const)(
        'does not report a late %s start as successful after Stop',
        async (kind) => {
            let finish!: (value: { status: string }) => void;
            const nativePlay = kind === 'playlist' ? bridge.native.playPlaylist : bridge.native.playTrackInPlaylist;
            nativePlay.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const starting =
                kind === 'playlist' ? music.playPlaylist('harbour') : music.playTrackInPlaylist('harbour', 'track');
            await music.stopMusic();
            finish({ status: 'playing' });
            expect(await starting).toMatchObject({ success: false, superseded: true });
            expect(await music.getNowPlaying()).toBeNull();
        },
    );

    it('does not let an older Stop response dismiss a newly selected playlist', async () => {
        let finish!: (value: { status: string }) => void;
        const stopped = vi.fn();
        music.subscribeMusicStopped(stopped);
        bridge.native.stop.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const stopping = music.stopMusic();
        await music.playPlaylist('new-playlist');
        finish({ status: 'stopped' });
        expect(JSON.parse((await stopping).content).status).toBe('superseded');
        expect(stopped).not.toHaveBeenCalled();
        expect(await music.getNowPlaying()).toMatchObject({ title: TRACK.title });
    });

    it('does not claim Pause succeeded when it was superseded or unconfirmed', async () => {
        bridge.native.pause.mockResolvedValueOnce({ status: 'superseded' });
        expect(JSON.parse((await music.pauseMusic()).content).status).toBe('superseded');
        bridge.native.pause.mockResolvedValueOnce({ status: 'failed' });
        expect((await music.pauseMusic()).isError).toBe(true);
    });

    it('keeps a confirmed Stop authoritative when a later Pause resolves first', async () => {
        let finish!: (value: { status: string }) => void;
        const stopped = vi.fn();
        music.subscribeMusicStopped(stopped);
        bridge.native.stop.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const stopping = music.stopMusic();
        await music.pauseMusic();
        finish({ status: 'stopped' });
        expect(JSON.parse((await stopping).content).status).toBe('stopped');
        expect(stopped).toHaveBeenCalledOnce();
        expect(await music.getNowPlaying()).toBeNull();
    });

    it('publishes the cleared queue when native Pause completes a pending Stop, without a duplicate event', async () => {
        let finish!: (value: { status: string }) => void;
        const stopped = vi.fn();
        music.subscribeMusicStopped(stopped);
        bridge.native.stop.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const stopping = music.stopMusic();
        bridge.native.pause.mockResolvedValueOnce({ status: 'stopped' });
        expect(JSON.parse((await music.pauseMusic()).content).status).toBe('stopped');
        finish({ status: 'stopped' });
        await stopping;
        expect(stopped).toHaveBeenCalledOnce();
        expect(await music.getNowPlaying()).toBeNull();
    });

    it('reports a genuine resume failure without claiming playback', async () => {
        bridge.native.resume.mockResolvedValueOnce({ status: 'failed', error: 'No audio route' });
        expect(await music.resumeMusic()).toMatchObject({ isError: true });
    });

    it.each(['rejected', 'unconfirmed', 'timeout'] as const)(
        'does not hide actual playback when Stop is %s',
        async (failure) => {
            const stopped = vi.fn();
            music.subscribeMusicStopped(stopped);
            if (failure === 'rejected') bridge.native.stop.mockRejectedValueOnce(new Error('bridge unavailable'));
            if (failure === 'unconfirmed') bridge.native.stop.mockResolvedValueOnce({ status: 'failed' });
            if (failure === 'timeout') bridge.native.stop.mockImplementationOnce(() => new Promise(() => undefined));
            const stopping = music.stopMusic();
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(12_000);
            expect((await stopping).isError).toBe(true);
            expect(stopped).not.toHaveBeenCalled();
            expect(await music.getNowPlaying()).toMatchObject({ title: TRACK.title });
        },
    );

    it('keeps web preview unsupported and never invokes native playback', async () => {
        bridge.isNative.mockReturnValue(false);
        expect(JSON.parse((await music.stopMusic()).content).status).toBe('unsupported');
        expect(await music.getNowPlaying()).toBeNull();
        expect(bridge.native.stop).not.toHaveBeenCalled();
        expect(bridge.native.nowPlaying).not.toHaveBeenCalled();
    });
});

describe('native MusicKit Stop contracts', () => {
    const source = readFileSync(resolve(process.cwd(), 'ios/App/App/AppleMusicPlugin.swift'), 'utf8');
    it('empties the queue, clears retained metadata and invalidates automatic voice resumption', () => {
        const clear = source.slice(
            source.indexOf('private func clearPlaybackQueue()'),
            source.indexOf('private func playCurrentQueue('),
        );
        expect(clear).toContain('player.pause()');
        expect(clear).toContain('player.queue = ApplicationMusicPlayer.Queue()');
        expect(clear).toContain('MPNowPlayingInfoCenter.default().nowPlayingInfo = nil');
        expect(clear).toContain('resumeMusicAfterVoiceInput = false');
        expect(source).toContain('let request = beginPlaybackRequest(stopped: true)');
        expect(source).toContain('guard request == self.currentPlaybackRequest() || self.isPlaybackStopped()');
        expect(source).toContain('playbackRequestAtTts == self.currentPlaybackRequest()');
    });
    it('fences hydration and every async prepare/play boundary before accepting playback', () => {
        for (const name of ['playPlaylist', 'playLibraryPlaylist', 'addPlaylistToQueue', 'playTrackInPlaylist']) {
            const start = source.indexOf(`@objc func ${name}(`);
            const end = source.indexOf('\n    @', start + 10);
            const body = source.slice(start, end);
            expect(body).toContain('let request = beginPlaybackRequest()');
            const guardIndex = body.indexOf('guard request == self.currentPlaybackRequest()');
            const assignmentIndex = body.indexOf('player.queue =');
            expect(guardIndex).toBeGreaterThanOrEqual(0);
            expect(assignmentIndex).toBeGreaterThanOrEqual(0);
            expect(guardIndex).toBeLessThan(assignmentIndex);
            expect(body).toContain('guard try await self.playCurrentQueue(request: request)');
        }
        const play = source.slice(
            source.indexOf('private func playCurrentQueue('),
            source.indexOf('private func skipQueueEntry('),
        );
        expect(play.match(/guard request == currentPlaybackRequest\(\)/g)).toHaveLength(4);
        expect(play).toContain('defer {');
        expect(play).toContain('if request != currentPlaybackRequest() { enforceLatestQuietIntent() }');
    });
    it('keeps queue reads and mutations on MainActor and reconciles later Pause without clearing its queue', () => {
        const pause = source.slice(source.indexOf('@objc func pause('), source.indexOf('@objc func stop('));
        expect(pause).toContain('let request = beginPauseRequest()');
        expect(pause).toContain('Task { @MainActor in');
        expect(pause).toContain('guard request == self.currentPlaybackRequest()');
        const quiet = source.slice(
            source.indexOf('private func enforceLatestQuietIntent('),
            source.indexOf('private func playCurrentQueue('),
        );
        expect(quiet).toContain('if intent.stopped {');
        expect(quiet).toContain('clearPlaybackQueue()');
        const paused = quiet.slice(quiet.indexOf('else if intent.paused'));
        expect(paused).toContain('ApplicationMusicPlayer.shared.pause()');
        expect(paused).not.toContain('clearPlaybackQueue()');
        expect(source.match(/skipQueueEntry\(forward: true, request: request\)/g)).toHaveLength(2);
        expect(source.match(/skipQueueEntry\(forward: false, request: request\)/g)).toHaveLength(2);
    });
    it('returns empty metadata both before artwork work and after a Stop racing that work', () => {
        const body = source.slice(source.indexOf('@objc func nowPlaying('), source.indexOf('// MARK: - TTS playback'));
        expect(body).toContain('Task { @MainActor [weak self] in');
        expect(body).toContain('if self.isPlaybackStopped() || player.queue.entries.isEmpty');
        expect(body).toContain('guard request == self.currentPlaybackRequest(), !self.isPlaybackStopped()');
        expect(body.match(/resolveEmptyNowPlaying\(call\)/g)).toHaveLength(2);
    });
});
