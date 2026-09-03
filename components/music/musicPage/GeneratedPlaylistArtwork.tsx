import React from 'react';
import type { PlaylistTrackPreview } from '../../../services/voice/integrations/appleMusic';

// ── Generated playlist artwork ─────────────────────────────────────
//
// When a user-made playlist has no curator-assigned cover, MusicKit
// returns a null artwork URL. This generator gives it a proper,
// understated Thalassa cover: a three-blob deep-water mesh gradient
// in a palette deterministically picked from the playlist name, a
// subtle horizon wave, and a serif initial overlaid in the centre.
//
// Deterministic = the same playlist always renders the same artwork
// across sessions, and the 2-col grid stays visually varied because
// adjacent playlists hash to different palettes.

/** 10 deep-water, chart-light, and warm-beacon palettes — every
 * playlist hashes to one. Deliberately no candy-colour treatment: a
 * mixed library should look calm, legible, and seaworthy. */
const PLAYLIST_PALETTES: ReadonlyArray<{ a: string; b: string; c: string; bg: string }> = [
    { a: '#22d3ee', b: '#0e7490', c: '#0c4a6e', bg: '#061827' }, // tidal cyan
    { a: '#38bdf8', b: '#2563eb', c: '#172554', bg: '#07152d' }, // bluewater
    { a: '#fbbf24', b: '#d97706', c: '#78350f', bg: '#21150a' }, // beacon amber
    { a: '#2dd4bf', b: '#0f766e', c: '#164e63', bg: '#061c25' }, // reef green
    { a: '#94a3b8', b: '#334155', c: '#0f172a', bg: '#070d16' }, // storm slate
    { a: '#f59e0b', b: '#ea580c', c: '#7c2d12', bg: '#211109' }, // sun on canvas
    { a: '#14b8a6', b: '#0891b2', c: '#0c4a6e', bg: '#08202a' }, // lagoon chart
    { a: '#a3e635', b: '#15803d', c: '#14532d', bg: '#071b16' }, // kelp line
    { a: '#fcd34d', b: '#b45309', c: '#713f12', bg: '#21180a' }, // brass compass
    { a: '#67e8f9', b: '#0284c7', c: '#1e3a8a', bg: '#07142a' }, // moonlit passage
];

function paletteFor(name: string): (typeof PLAYLIST_PALETTES)[number] {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) | 0;
    }
    return PLAYLIST_PALETTES[Math.abs(h) % PLAYLIST_PALETTES.length];
}

/**
 * Pick a 1-2 character monogram from the playlist name. Single short
 * names get two letters ("XO" → "XO"), longer names get the first
 * letter of the first significant word. Articles ("the", "a", "my")
 * get skipped so "My Sunset Mix" → "S".
 */
function monogramFor(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return '♪';
    const words = trimmed.split(/\s+/);
    const skip = new Set(['the', 'a', 'an', 'my', 'our']);
    const first = words.find((w) => !skip.has(w.toLowerCase())) ?? words[0];
    if (words.length === 1 && first.length <= 3) return first.toUpperCase();
    return first.charAt(0).toUpperCase();
}

export const GeneratedPlaylistArtwork: React.FC<{
    name: string;
    /** First few tracks to preview on the cover. When provided we
     *  render a song list instead of the serif monogram — gives the
     *  skipper a peek at what's inside without opening the playlist.
     *  Empty / undefined falls back to the monogram (e.g. now-playing
     *  thumbnail where the list wouldn't fit anyway). */
    previewTracks?: PlaylistTrackPreview[];
}> = ({ name, previewTracks }) => {
    const palette = paletteFor(name);
    const tracks = previewTracks ?? [];
    const showList = tracks.length > 0;
    const monogram = monogramFor(name);
    return (
        <div
            className="w-full h-full relative overflow-hidden"
            style={{
                background: `
                    radial-gradient(at 22% 18%, ${palette.a} 0%, transparent 55%),
                    radial-gradient(at 82% 28%, ${palette.b} 0%, transparent 50%),
                    radial-gradient(at 48% 88%, ${palette.c} 0%, transparent 55%),
                    ${palette.bg}
                `,
            }}
        >
            {/* Bright bloom — adds a touch of polish */}
            <div
                className="absolute -top-8 -right-8 w-28 h-28 rounded-full opacity-50 blur-2xl pointer-events-none"
                style={{ background: palette.a }}
            />
            {/* Horizon wave — Thalassa's marine signature, very subtle */}
            <svg
                className="absolute bottom-0 left-0 w-full pointer-events-none"
                viewBox="0 0 200 60"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path d="M0,30 Q50,12 100,30 T200,30 L200,60 L0,60 Z" fill="white" opacity="0.06" />
                <path d="M0,40 Q50,22 100,40 T200,40 L200,60 L0,60 Z" fill="white" opacity="0.05" />
            </svg>
            {showList ? (
                /* Track list — title flush left, artist indented underneath.
                 * Sits in the upper portion of the tile; the bottom title
                 * overlay (rendered by the caller) hides anything that
                 * runs past the safe zone, so we don't need to clip
                 * exactly N tracks — just enough to fill comfortably. */
                <div className="absolute inset-x-2.5 top-2.5 bottom-14 overflow-hidden pointer-events-none">
                    <div className="space-y-1.5">
                        {tracks.slice(0, 4).map((t, i) => (
                            <div key={i} className="leading-tight">
                                <div
                                    className="text-white text-[10.5px] font-semibold truncate"
                                    style={{ textShadow: '0 1px 4px rgba(0,0,0,0.35)' }}
                                >
                                    {t.title}
                                </div>
                                {t.artist && (
                                    <div className="text-white/65 text-[9px] truncate pl-2.5 mt-0.5">{t.artist}</div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                /* Empty playlist — fall back to the serif monogram. */
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div
                        className="text-white/80 leading-none select-none"
                        style={{
                            fontFamily: 'Georgia, "Times New Roman", serif',
                            fontWeight: 600,
                            fontSize: monogram.length > 1 ? '3.75rem' : '4.5rem',
                            textShadow: '0 4px 16px rgba(0,0,0,0.35)',
                            letterSpacing: monogram.length > 1 ? '-0.02em' : '0',
                        }}
                    >
                        {monogram}
                    </div>
                </div>
            )}
        </div>
    );
};
