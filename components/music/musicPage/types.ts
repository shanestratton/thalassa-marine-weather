import type {
    CatalogSongResult,
    NowPlaying,
    PlaylistTrack,
    UserPlaylist,
} from '../../../services/voice/integrations/appleMusic';

export interface MusicPageProps {
    onBack: () => void;
}

export interface PlaylistPreviewJob {
    playlist: UserPlaylist;
    generation: number;
}

export const MAX_CONCURRENT_PLAYLIST_PREVIEWS = 2;

export interface PlaylistTileProps {
    playlist: UserPlaylist;
    active: boolean;
    /** Called with the playlist id so the parent can hold ONE stable handler
     *  for the whole rail — a per-tile closure defeated React.memo and the
     *  1 s now-playing poll repainted every card. */
    onTap: (playlistId: string) => void;
    onLongPress: (playlist: UserPlaylist) => void;
}

/** Hold this long for the tap to register as a long-press. Matches
 *  iOS's default long-press recognition window so it feels native. */
export const LONG_PRESS_MS = 500;

export interface PlaylistDetailSheetProps {
    playlist: UserPlaylist;
    tracks: PlaylistTrack[];
    loading: boolean;
    error: string | null;
    covered: boolean;
    onClose: () => void;
    onPlayAll: () => void;
    onPlayTrack: (trackId: string) => void;
    onAddTracks: () => void;
    onDelete: () => void;
}

export interface AddTracksSheetProps {
    playlistName: string;
    onClose: () => void;
    /** Try to add a song. Returns one of:
     *    "added"    — direct add succeeded
     *    "redirect" — Apple doesn't allow it; the parent already
     *                 opened the song in Apple Music app for manual add
     *    "failed"   — generic failure
     *
     * Full song object is passed (not just id) so the parent can do
     * an optimistic UI append without re-fetching the catalog. */
    onAddSong: (song: CatalogSongResult) => Promise<'added' | 'redirect' | 'failed'>;
}

export interface SongResultRowProps {
    song: CatalogSongResult;
    adding: boolean;
    added: boolean;
    redirected: boolean;
    onAdd: () => void;
}

export interface DeleteConfirmSheetProps {
    playlistName: string;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export interface CreatePlaylistSheetProps {
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (name: string, description: string) => void;
}

export interface NowPlayingStageProps {
    nowPlaying: NowPlaying | null;
    /** Name of the playlist the current queue came from, when known. */
    playlistName: string | null;
    speaker: { name: string; icon: string } | null;
    onPause: () => void;
    onResume: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onPickSpeaker: () => void;
}
