import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PanePortalScope } from '../../context/PanePortalContext';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const mode = params.get('mode') || 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');

const playlists = [
    { id: 'harbour', name: 'Harbour After Hours', curator: 'Your library', artwork_url: '' },
    { id: 'passage', name: 'The Long Way Home — Offshore Favourites', curator: 'Your library', artwork_url: '' },
    { id: 'morning', name: 'First Light', curator: 'Your library', artwork_url: '' },
];
const tracks = [
    { id: 'song-1', title: 'Sea Song', artist: 'The Harbour Crew', duration_ms: 184_000, artwork_url: '' },
    {
        id: 'song-2',
        title: 'Lights Across the Water',
        artist: 'Northern Passage',
        duration_ms: 216_000,
        artwork_url: '',
    },
    { id: 'song-3', title: 'A Quiet Anchorage', artist: 'The Harbour Crew', duration_ms: 192_000, artwork_url: '' },
];
const control = { playing: false, queue: [] as string[], stops: 0, pauses: 0, plays: 0, hasPlayed: false };
Object.assign(window, { __musicFixture: control });

// Real page, bridge wrapper, playlist components and pane portals; only the
// native service is in-memory. No audio, MusicKit account, or library mutation.
// Keep old metadata after Stop deliberately: the real wrapper must fence it.
registerPlugin('AppleMusic', {
    web: () => ({
        getMusicKitAuthorizationStatus: async () => ({ status: 'authorized', granted: true }),
        getUserPlaylists: async () => ({ status: 'ok', playlists }),
        getPlaylistTracks: async ({ id }: { id: string }) => ({
            status: 'ok',
            playlist_name: playlists.find((p) => p.id === id)?.name,
            tracks,
        }),
        getAudioRoute: async () => ({ outputs: [], primaryName: 'This iPhone' }),
        nowPlaying: async () => ({
            title: control.hasPlayed ? tracks[0].title : '',
            artist: tracks[0].artist,
            album: 'Harbour',
            artwork_url: '',
            is_playing: control.playing,
            state: control.playing ? 'playing' : 'paused',
            playback_time: 43,
            duration: 184,
        }),
        playPlaylist: async ({ id }: { id: string }) => {
            control.playing = true;
            control.hasPlayed = true;
            control.plays += 1;
            control.queue = tracks.map((track) => track.id);
            return { status: 'playing', playlist_name: playlists.find((p) => p.id === id)?.name };
        },
        pause: async () => {
            control.playing = false;
            control.pauses += 1;
            return { status: 'paused' };
        },
        resume: async () => {
            control.playing = !!control.queue.length;
            return { status: control.playing ? 'playing' : 'no_queue' };
        },
        stop: async () => {
            control.playing = false;
            control.queue = [];
            control.stops += 1;
            return { status: 'stopped' };
        },
    }),
});
Capacitor.isNativePlatform = () => true;
Capacitor.getPlatform = () => 'ios';
// Register before dynamically importing MusicPage's real bridge wrapper.
const { MusicPage } = await import('../../components/music/MusicPage');

function Fixture() {
    const frameRef = useRef<HTMLDivElement>(null);
    return (
        <main className="flex h-dvh w-full flex-col overflow-hidden bg-slate-950 text-white">
            <header className="flex h-20 shrink-0 items-center px-4 font-bold text-slate-300">THALASSA</header>
            <div className={`flex min-h-0 flex-1 ${pane ? 'gap-2 p-2 pb-16' : ''}`}>
                {pane && (
                    <aside className="min-w-0 flex-1 rounded-2xl bg-slate-900 p-4" aria-label="Companion pane">
                        Glass companion pane
                    </aside>
                )}
                <section
                    ref={frameRef}
                    className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
                    data-testid="music-pane"
                    data-split-pane={pane ? 'vessel' : undefined}
                >
                    <PanePortalScope enabled={pane} paneId="vessel" frameRef={frameRef}>
                        <MusicPage onBack={() => undefined} />
                    </PanePortalScope>
                </section>
            </div>
            {mode === 'night' && (
                <div
                    className="pointer-events-none fixed inset-0"
                    data-testid="night-scrim"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
