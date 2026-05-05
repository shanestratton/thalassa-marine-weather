/**
 * Apple Music integration for Calypso — MusicKit-based.
 *
 * Rebuilt 2026-05-04 from MPMediaQuery / MPMusicPlayerController to
 * pure MusicKit. The legacy APIs couldn't play DRM Apple Music
 * subscription content; MusicKit handles streaming subscription
 * playback natively, gives us catalog access (~100M tracks), and
 * coexists more cleanly with our app's audio session for TTS.
 *
 * Surfaces:
 *   - MusicPage component reads getUserPlaylists() + calls
 *     playPlaylist(id) on tap
 *   - Calypso voice tools: searchAndPlay (catalog), pause, resume,
 *     skip, nowPlaying
 *   - All TTS playback (Calypso's voice) routes through
 *     playTtsAudio() which uses native AVAudioPlayer; bypasses
 *     WKWebView's HTML5 Audio black box.
 *
 * Permission: MusicAuthorization.request() via the MusicKit plugin
 * method — uses NSAppleMusicUsageDescription from Info.plist for
 * the prompt text.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

// ── Native plugin bridge ────────────────────────────────────────────

interface AppleMusicPluginInterface {
    // Authorization
    requestMusicKitAuthorization(): Promise<{ status: string; granted: boolean }>;
    getMusicKitAuthorizationStatus(): Promise<{ status: string; granted: boolean }>;

    // Catalog playback (entire Apple Music ~100M tracks)
    searchAndPlay(opts: { query: string; kind?: 'auto' | 'songs' | 'albums' | 'artists' | 'playlists' }): Promise<{
        status: 'playing' | 'not_found' | 'permission_denied' | 'playback_failed';
        matched_kind?: '' | 'songs' | 'albums' | 'artists' | 'playlists';
        title?: string;
        subtitle?: string;
        first_track_title?: string;
        first_track_artist?: string;
        track_count?: number;
        auth_status?: string;
        query?: string;
    }>;

    // User library
    getUserPlaylists(): Promise<{
        status: 'ok' | 'permission_denied' | 'error';
        playlists: Array<{
            id: string;
            name: string;
            curator: string;
            artwork_url: string;
            preview_tracks?: Array<{ title: string; artist: string }>;
        }>;
        error?: string;
    }>;
    playPlaylist(opts: { id: string }): Promise<{
        status: 'playing' | 'not_found' | 'error';
        playlist_name?: string;
        track_count?: number;
        first_track_title?: string;
        first_track_artist?: string;
        error?: string;
    }>;
    getPlaylistTracks(opts: { id: string }): Promise<{
        status: 'ok' | 'not_found' | 'error';
        playlist_name?: string;
        tracks?: Array<{
            id: string;
            title: string;
            artist: string;
            duration_ms: number;
            artwork_url: string;
        }>;
        error?: string;
    }>;
    addPlaylistToQueue(opts: { id: string }): Promise<{
        status: 'queued' | 'playing' | 'not_found' | 'error';
        playlist_name?: string;
        track_count?: number;
        error?: string;
    }>;
    playTrackInPlaylist(opts: { playlist_id: string; track_id: string }): Promise<{
        status: 'playing' | 'not_found' | 'track_not_found' | 'error';
        title?: string;
        artist?: string;
        error?: string;
    }>;
    playLibraryPlaylist(opts: { query: string }): Promise<{
        status: 'playing' | 'not_found' | 'empty' | 'error';
        playlist_name?: string;
        track_count?: number;
        first_track_title?: string;
        first_track_artist?: string;
        query?: string;
        error?: string;
    }>;
    createPlaylist(opts: { name: string; description?: string }): Promise<{
        status: 'ok' | 'error';
        id?: string;
        name?: string;
        error?: string;
    }>;
    addCurrentTrackToPlaylist(opts: { playlist: string }): Promise<{
        status: 'ok' | 'playlist_not_found' | 'no_track_playing' | 'not_a_song' | 'error';
        playlist_name?: string;
        track_title?: string;
        track_artist?: string;
        query?: string;
        error?: string;
    }>;
    searchCatalogSongs(opts: { query: string; limit?: number }): Promise<{
        status: 'ok' | 'error';
        songs?: Array<{
            id: string;
            title: string;
            artist: string;
            album?: string;
            duration_ms: number;
            artwork_url: string;
        }>;
        error?: string;
    }>;
    addSongToPlaylist(opts: { song_id: string; playlist_id: string }): Promise<{
        status: 'ok' | 'song_not_in_cache' | 'playlist_not_found' | 'error';
        playlist_name?: string;
        song_title?: string;
        song_artist?: string;
        error?: string;
    }>;
    deletePlaylist(opts: { id: string }): Promise<{
        status: 'ok' | 'not_found' | 'error';
        playlist_name?: string;
        error?: string;
    }>;

    // Playback control
    pause(): Promise<{ status: string }>;
    resume(): Promise<{ status: string; error?: string }>;
    next(): Promise<{ status: string }>;
    previous(): Promise<{ status: string }>;
    nowPlaying(): Promise<{
        is_playing: boolean;
        state: string;
        title: string;
        artist: string;
        album: string;
        artwork_url: string;
    }>;

    // TTS
    playTtsAudio(opts: { audio_b64: string }): Promise<{ status: string }>;
    cancelTtsAudio(): Promise<{ status: string }>;
}

const AppleMusicNative = registerPlugin<AppleMusicPluginInterface>('AppleMusic');

function nativeAvailable(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

// ── Authorization ──────────────────────────────────────────────────

export interface AuthResult {
    granted: boolean;
    status: string;
}

export async function requestAuthorization(): Promise<AuthResult> {
    if (!nativeAvailable()) return { granted: false, status: 'unsupported' };
    try {
        const r = await AppleMusicNative.requestMusicKitAuthorization();
        return { granted: r.granted, status: r.status };
    } catch (err) {
        return { granted: false, status: `error: ${(err as Error).message}` };
    }
}

export async function getAuthorizationStatus(): Promise<AuthResult> {
    if (!nativeAvailable()) return { granted: false, status: 'unsupported' };
    try {
        const r = await AppleMusicNative.getMusicKitAuthorizationStatus();
        return { granted: r.granted, status: r.status };
    } catch (err) {
        return { granted: false, status: `error: ${(err as Error).message}` };
    }
}

// ── User playlists ─────────────────────────────────────────────────

export interface PlaylistTrackPreview {
    title: string;
    artist: string;
}

export interface UserPlaylist {
    id: string;
    name: string;
    curator: string;
    artworkUrl: string;
    /** First few tracks in the playlist, surfaced on the tile cover
     *  so the skipper can see what's inside at a glance. Empty when
     *  the playlist has no tracks (or hydration failed). */
    previewTracks: PlaylistTrackPreview[];
}

export interface UserPlaylistsResult {
    available: boolean;
    reason?: 'unsupported' | 'permission_denied' | 'plugin_error';
    error?: string;
    playlists: UserPlaylist[];
}

export async function getUserPlaylists(): Promise<UserPlaylistsResult> {
    if (!nativeAvailable()) {
        return { available: false, reason: 'unsupported', playlists: [] };
    }
    try {
        const r = await AppleMusicNative.getUserPlaylists();
        if (r.status !== 'ok') {
            return {
                available: false,
                reason: r.status === 'permission_denied' ? 'permission_denied' : 'plugin_error',
                error: r.error,
                playlists: [],
            };
        }
        return {
            available: true,
            playlists: r.playlists.map((p) => ({
                id: p.id,
                name: p.name,
                curator: p.curator,
                artworkUrl: p.artwork_url,
                previewTracks: (p.preview_tracks ?? []).map((t) => ({
                    title: t.title,
                    artist: t.artist,
                })),
            })),
        };
    } catch (err) {
        return {
            available: false,
            reason: 'plugin_error',
            error: (err as Error).message,
            playlists: [],
        };
    }
}

export async function playPlaylist(id: string): Promise<{
    success: boolean;
    name?: string;
    trackCount?: number;
    firstTrack?: { title: string; artist: string };
    error?: string;
}> {
    if (!nativeAvailable()) return { success: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.playPlaylist({ id });
        if (r.status === 'playing') {
            return {
                success: true,
                name: r.playlist_name,
                trackCount: r.track_count,
                firstTrack: r.first_track_title
                    ? { title: r.first_track_title, artist: r.first_track_artist ?? '' }
                    : undefined,
            };
        }
        return { success: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

// ── Playlist detail (for the long-press bottom sheet) ──────────────

export interface PlaylistTrack {
    id: string;
    title: string;
    artist: string;
    durationMs: number;
    artworkUrl: string;
}

export interface PlaylistDetailResult {
    available: boolean;
    name: string;
    tracks: PlaylistTrack[];
    error?: string;
}

export async function getPlaylistTracks(id: string): Promise<PlaylistDetailResult> {
    if (!nativeAvailable()) {
        return { available: false, name: '', tracks: [], error: 'unsupported' };
    }
    try {
        const r = await AppleMusicNative.getPlaylistTracks({ id });
        if (r.status !== 'ok' || !r.tracks) {
            return {
                available: false,
                name: r.playlist_name ?? '',
                tracks: [],
                error: r.error ?? r.status,
            };
        }
        return {
            available: true,
            name: r.playlist_name ?? '',
            tracks: r.tracks.map((t) => ({
                id: t.id,
                title: t.title,
                artist: t.artist,
                durationMs: t.duration_ms,
                artworkUrl: t.artwork_url,
            })),
        };
    } catch (err) {
        return { available: false, name: '', tracks: [], error: (err as Error).message };
    }
}

/**
 * Add every track in a playlist to the current playback queue. If
 * nothing is playing, behaves like playPlaylist (set queue + play).
 * If something IS playing, the playlist's tracks queue up after.
 */
export async function addPlaylistToQueue(id: string): Promise<{
    success: boolean;
    appended: boolean; // true if appended to existing queue, false if started fresh playback
    name?: string;
    trackCount?: number;
    error?: string;
}> {
    if (!nativeAvailable()) return { success: false, appended: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.addPlaylistToQueue({ id });
        if (r.status === 'queued' || r.status === 'playing') {
            return {
                success: true,
                appended: r.status === 'queued',
                name: r.playlist_name,
                trackCount: r.track_count,
            };
        }
        return { success: false, appended: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, appended: false, error: (err as Error).message };
    }
}

/**
 * Play a specific track in a playlist, queuing the rest of the
 * playlist (from that track onwards) after it. The "tap a song in
 * an album" UX.
 */
export async function playTrackInPlaylist(
    playlistId: string,
    trackId: string,
): Promise<{ success: boolean; title?: string; artist?: string; error?: string }> {
    if (!nativeAvailable()) return { success: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.playTrackInPlaylist({
            playlist_id: playlistId,
            track_id: trackId,
        });
        if (r.status === 'playing') {
            return { success: true, title: r.title, artist: r.artist };
        }
        return { success: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

// ── Library playlist by name (voice tool) ─────────────────────────

/**
 * Voice-friendly "play one of my library playlists by name." Returns
 * the orchestrator-shaped { content, isError } envelope so it slots
 * straight into the tool dispatcher. Fuzzy-matches the playlist name
 * server-side; reliably works without catalog auth.
 */
export async function playLibraryPlaylistByName(query: string): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    if (!trimmed) return { content: 'ERROR: empty playlist query', isError: true };
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        const r = await AppleMusicNative.playLibraryPlaylist({ query: trimmed });
        if (r.status === 'playing') {
            const phrase = r.first_track_title
                ? `Playing "${r.first_track_title}"${
                      r.first_track_artist ? ` by ${r.first_track_artist}` : ''
                  } from your "${r.playlist_name}" playlist.`
                : `Playing your "${r.playlist_name}" playlist.`;
            return {
                content: JSON.stringify({
                    status: 'playing',
                    playlist_name: r.playlist_name,
                    track_count: r.track_count,
                    suggested_phrase: phrase,
                    note: 'Read the suggested_phrase aloud verbatim.',
                }),
                isError: false,
            };
        }
        if (r.status === 'not_found') {
            return {
                content: JSON.stringify({
                    status: 'not_found',
                    query: trimmed,
                    note: `No library playlist matches "${trimmed}". Tell the skipper plainly. They can ask "what playlists do I have?" to hear the list.`,
                }),
                isError: false,
            };
        }
        if (r.status === 'empty') {
            return {
                content: JSON.stringify({
                    status: 'empty',
                    playlist_name: r.playlist_name,
                    note: `The playlist "${r.playlist_name}" matched but it has no tracks.`,
                }),
                isError: false,
            };
        }
        return {
            content: JSON.stringify({
                status: 'error',
                error: r.error ?? 'unknown',
            }),
            isError: false,
        };
    } catch (err) {
        return {
            content: `ERROR: playLibraryPlaylist failed — ${(err as Error).message}`,
            isError: true,
        };
    }
}

/**
 * Return a short list of playlist names for "what playlists do I have?".
 * Wraps getUserPlaylists; trims to 15 names so the spoken response
 * stays digestible.
 */
export async function listLibraryPlaylistNames(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    const r = await getUserPlaylists();
    if (!r.available) {
        return {
            content: JSON.stringify({
                status: r.reason ?? 'error',
                error: r.error,
            }),
            isError: false,
        };
    }
    const names = r.playlists.map((p) => p.name).slice(0, 15);
    return {
        content: JSON.stringify({
            status: 'ok',
            count: r.playlists.length,
            names,
            note:
                names.length === 0
                    ? "Skipper has no playlists yet. Tell them they can build some in Apple Music or say 'create a playlist called X'."
                    : "Read 5-7 names back naturally — don't recite all of them. End with something like 'and a few more — want me to look one up?' if there are more.",
        }),
        isError: false,
    };
}

// ── Library mutations (create + add track) ─────────────────────────

export async function createPlaylistByName(
    name: string,
    description?: string,
): Promise<{ success: boolean; id?: string; name?: string; error?: string }> {
    const trimmed = (name || '').trim();
    if (!trimmed) return { success: false, error: 'empty name' };
    if (!nativeAvailable()) return { success: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.createPlaylist({
            name: trimmed,
            description: description?.trim() || undefined,
        });
        if (r.status === 'ok') {
            return { success: true, id: r.id, name: r.name };
        }
        return { success: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Voice-friendly version of createPlaylist for the orchestrator.
 */
export async function createPlaylistVoice(
    name: string,
    description?: string,
): Promise<{ content: string; isError: boolean }> {
    const trimmed = (name || '').trim();
    if (!trimmed) return { content: 'ERROR: empty playlist name', isError: true };
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    const r = await createPlaylistByName(trimmed, description);
    if (!r.success) {
        return {
            content: JSON.stringify({
                status: 'error',
                error: r.error,
                note: 'Could not create the playlist. Tell the skipper plainly.',
            }),
            isError: false,
        };
    }
    return {
        content: JSON.stringify({
            status: 'ok',
            playlist_name: r.name,
            suggested_phrase: `Created your "${r.name}" playlist.`,
            note: 'Read the suggested_phrase aloud. Briefly mention they can now ask to add the current track to it.',
        }),
        isError: false,
    };
}

/**
 * Voice-friendly "add what's playing now to my <playlist>" helper.
 */
export async function saveCurrentTrackToPlaylist(
    playlistQuery: string,
): Promise<{ content: string; isError: boolean }> {
    const trimmed = (playlistQuery || '').trim();
    if (!trimmed) return { content: 'ERROR: empty playlist query', isError: true };
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        const r = await AppleMusicNative.addCurrentTrackToPlaylist({ playlist: trimmed });
        if (r.status === 'ok') {
            return {
                content: JSON.stringify({
                    status: 'ok',
                    playlist_name: r.playlist_name,
                    track_title: r.track_title,
                    track_artist: r.track_artist,
                    suggested_phrase: `Saved "${r.track_title}"${
                        r.track_artist ? ` by ${r.track_artist}` : ''
                    } to your "${r.playlist_name}" playlist.`,
                    note: 'Read the suggested_phrase verbatim.',
                }),
                isError: false,
            };
        }
        if (r.status === 'playlist_not_found') {
            return {
                content: JSON.stringify({
                    status: 'playlist_not_found',
                    query: trimmed,
                    note: `No library playlist matches "${trimmed}". Tell the skipper plainly.`,
                }),
                isError: false,
            };
        }
        if (r.status === 'no_track_playing') {
            return {
                content: JSON.stringify({
                    status: 'no_track_playing',
                    note: 'Nothing is currently playing — there is no track to save. Tell the skipper plainly.',
                }),
                isError: false,
            };
        }
        if (r.status === 'not_a_song') {
            return {
                content: JSON.stringify({
                    status: 'not_a_song',
                    note: 'Current item is a music video, not a song. Save is only supported for songs.',
                }),
                isError: false,
            };
        }
        return {
            content: JSON.stringify({
                status: 'error',
                error: r.error ?? 'unknown',
                note: 'Could not save the track. Tell the skipper plainly.',
            }),
            isError: false,
        };
    } catch (err) {
        return {
            content: `ERROR: addCurrentTrackToPlaylist failed — ${(err as Error).message}`,
            isError: true,
        };
    }
}

// ── Catalog song search (for the Add-to-playlist sheet) ───────────

export interface CatalogSongResult {
    id: string;
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
    artworkUrl: string;
}

export async function searchCatalogSongs(
    query: string,
    limit?: number,
): Promise<{ available: boolean; songs: CatalogSongResult[]; error?: string }> {
    const trimmed = (query || '').trim();
    if (!trimmed) return { available: false, songs: [], error: 'empty query' };
    if (!nativeAvailable()) return { available: false, songs: [], error: 'unsupported' };
    try {
        const r = await AppleMusicNative.searchCatalogSongs({ query: trimmed, limit });
        if (r.status !== 'ok' || !r.songs) {
            return { available: false, songs: [], error: r.error ?? r.status };
        }
        return {
            available: true,
            songs: r.songs.map((s) => ({
                id: s.id,
                title: s.title,
                artist: s.artist,
                album: s.album,
                durationMs: s.duration_ms,
                artworkUrl: s.artwork_url,
            })),
        };
    } catch (err) {
        return { available: false, songs: [], error: (err as Error).message };
    }
}

export async function addSongToPlaylist(
    songId: string,
    playlistId: string,
): Promise<{ success: boolean; playlistName?: string; songTitle?: string; songArtist?: string; error?: string }> {
    if (!nativeAvailable()) return { success: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.addSongToPlaylist({ song_id: songId, playlist_id: playlistId });
        if (r.status === 'ok') {
            return {
                success: true,
                playlistName: r.playlist_name,
                songTitle: r.song_title,
                songArtist: r.song_artist,
            };
        }
        return { success: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export async function deletePlaylistById(
    id: string,
): Promise<{ success: boolean; playlistName?: string; error?: string }> {
    if (!nativeAvailable()) return { success: false, error: 'unsupported' };
    try {
        const r = await AppleMusicNative.deletePlaylist({ id });
        if (r.status === 'ok') {
            return { success: true, playlistName: r.playlist_name };
        }
        return { success: false, error: r.error ?? r.status };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

// ── Catalog search + play ──────────────────────────────────────────

export async function playMusicByQuery(
    query: string,
    kind?: 'auto' | 'songs' | 'albums' | 'artists' | 'playlists',
): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    if (!trimmed) return { content: 'ERROR: empty music query', isError: true };
    if (!nativeAvailable()) {
        return {
            content: JSON.stringify({
                status: 'unsupported',
                note: 'MusicKit playback requires the native iOS plugin.',
            }),
            isError: false,
        };
    }
    try {
        const r = await AppleMusicNative.searchAndPlay({ query: trimmed, kind: kind ?? 'auto' });
        if (r.status === 'playing') {
            const trackTitle = r.first_track_title ?? '';
            const trackArtist = r.first_track_artist ?? '';
            const phrase = trackTitle
                ? `Playing "${trackTitle}"${trackArtist ? ` by ${trackArtist}` : ''}${
                      r.matched_kind === 'artists' && r.track_count ? ` — ${r.track_count} tracks` : ''
                  }.`
                : `Playing ${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''}.`;
            return {
                content: JSON.stringify({
                    status: 'playing',
                    matched_kind: r.matched_kind,
                    title: r.title,
                    subtitle: r.subtitle,
                    first_track_title: trackTitle,
                    first_track_artist: trackArtist,
                    track_count: r.track_count,
                    suggested_phrase: phrase,
                    note: 'Read the suggested_phrase aloud verbatim. The full Apple Music catalog is now playing.',
                }),
                isError: false,
            };
        }
        if (r.status === 'permission_denied') {
            return {
                content: JSON.stringify({
                    status: 'permission_denied',
                    auth_status: r.auth_status,
                    note: 'Apple Music access not granted. Tell the skipper to enable it via the Music page in the app, or in iOS Settings → Thalassa.',
                }),
                isError: false,
            };
        }
        if (r.status === 'not_found') {
            return {
                content: JSON.stringify({
                    status: 'not_found',
                    query: trimmed,
                    note: `No Apple Music match for "${trimmed}". Tell the skipper plainly.`,
                }),
                isError: false,
            };
        }
        return {
            content: JSON.stringify({
                status: 'playback_failed',
                title: r.title,
                note: 'MusicKit returned a search match but playback failed to start. Could be subscription state or network. Tell the skipper.',
            }),
            isError: false,
        };
    } catch (err) {
        return {
            content: `ERROR: MusicKit searchAndPlay failed — ${(err as Error).message}`,
            isError: true,
        };
    }
}

// ── Playback control ───────────────────────────────────────────────

export async function pauseMusic(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        await AppleMusicNative.pause();
        return { content: JSON.stringify({ status: 'paused' }), isError: false };
    } catch (err) {
        return { content: `ERROR: pause failed — ${(err as Error).message}`, isError: true };
    }
}

export async function resumeMusic(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        const r = await AppleMusicNative.resume();
        return { content: JSON.stringify({ status: r.status }), isError: false };
    } catch (err) {
        return { content: `ERROR: resume failed — ${(err as Error).message}`, isError: true };
    }
}

export async function skipNext(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        await AppleMusicNative.next();
        return { content: JSON.stringify({ status: 'skipped_to_next' }), isError: false };
    } catch (err) {
        return { content: `ERROR: skip failed — ${(err as Error).message}`, isError: true };
    }
}

export async function skipPrevious(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        await AppleMusicNative.previous();
        return { content: JSON.stringify({ status: 'skipped_to_previous' }), isError: false };
    } catch (err) {
        return { content: `ERROR: previous failed — ${(err as Error).message}`, isError: true };
    }
}

export interface NowPlaying {
    isPlaying: boolean;
    state: string;
    title: string;
    artist: string;
    album: string;
    artworkUrl: string;
}

export async function getNowPlaying(): Promise<NowPlaying | null> {
    if (!nativeAvailable()) return null;
    try {
        const r = await AppleMusicNative.nowPlaying();
        return {
            isPlaying: r.is_playing,
            state: r.state,
            title: r.title,
            artist: r.artist,
            album: r.album,
            artworkUrl: r.artwork_url,
        };
    } catch {
        return null;
    }
}

export async function nowPlaying(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported' }), isError: false };
    }
    try {
        const r = await AppleMusicNative.nowPlaying();
        return {
            content: JSON.stringify({
                ...r,
                note:
                    r.title.length === 0
                        ? 'Nothing currently playing. Say so plainly.'
                        : 'Read back title + artist naturally.',
            }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: nowPlaying failed — ${(err as Error).message}`, isError: true };
    }
}
