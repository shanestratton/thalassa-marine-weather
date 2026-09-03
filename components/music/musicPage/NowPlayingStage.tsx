import React, { useEffect, useRef, useState } from 'react';
import { SafeImage } from '../../ui/SafeImage';
import { GeneratedPlaylistArtwork } from './GeneratedPlaylistArtwork';
import { SpeakerChip } from './SpeakerChip';
import { formatPlaybackTime } from './helpers';
import { MusicIcon, PauseIcon, PlayIcon, SkipNextIcon, SkipPrevIcon } from './icons';
import type { NowPlayingStageProps } from './types';

// ── Now playing stage ──────────────────────────────────────────────
// The page's hero: playback isn't a footnote in a floating bar any
// more, it IS the top of the page. Blurred artwork backdrop, big art,
// a proper thumb-sized transport, and the speaker (output) control
// living where output controls belong — next to the transport.

export const NowPlayingStage: React.FC<NowPlayingStageProps> = ({
    nowPlaying,
    playlistName,
    speaker,
    onPause,
    onResume,
    onNext,
    onPrevious,
    onPickSpeaker,
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const artworkUrl = nowPlaying?.artworkUrl;
    const showRemote = !!artworkUrl && !imageFailed;
    // Reset the failure flag whenever the track changes — different
    // artwork URLs deserve fresh load attempts.
    useEffect(() => {
        setImageFailed(false);
    }, [artworkUrl]);

    // ── Smoothed playback time ─────────────────────────────────────
    // The parent polls native `nowPlaying` once a second, so the raw
    // playbackTime only updates at 1Hz — a visibly stepping progress
    // bar. Interpolate locally at ~10Hz while playing, snapping back
    // to the authoritative value every time a new poll lands.
    const pollTime = nowPlaying?.playbackTime ?? 0;
    const duration = nowPlaying?.duration ?? 0;
    const isPlaying = !!nowPlaying?.isPlaying;
    const [smoothTime, setSmoothTime] = useState(pollTime);
    const lastPollRef = useRef({ value: pollTime, at: Date.now() });

    useEffect(() => {
        lastPollRef.current = { value: pollTime, at: Date.now() };
        setSmoothTime(pollTime);
    }, [pollTime, isPlaying]);

    useEffect(() => {
        if (!isPlaying || duration <= 0) return;
        const id = window.setInterval(() => {
            const elapsed = (Date.now() - lastPollRef.current.at) / 1000;
            setSmoothTime(Math.min(duration, lastPollRef.current.value + elapsed));
        }, 100);
        return () => window.clearInterval(id);
    }, [isPlaying, duration]);

    // ── Idle stage — inviting, not empty ───────────────────────────
    if (!nowPlaying?.title) {
        return (
            <section className="relative overflow-hidden rounded-3xl border border-sky-400/15 bg-linear-to-br from-sky-400/8 via-slate-900/70 to-slate-950/85 px-4 py-4 shadow-xl">
                <svg
                    className="pointer-events-none absolute bottom-0 left-0 w-full opacity-60"
                    viewBox="0 0 200 40"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                >
                    <path d="M0,20 Q50,6 100,20 T200,20 L200,40 L0,40 Z" fill="white" opacity="0.04" />
                    <path d="M0,28 Q50,14 100,28 T200,28 L200,40 L0,40 Z" fill="white" opacity="0.035" />
                </svg>
                <div className="relative flex items-center gap-3.5">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-sky-400/25 bg-sky-400/10">
                        <MusicIcon className="h-6 w-6 text-sky-300" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-200/70">
                            All quiet on deck
                        </div>
                        <div className="mt-0.5 text-base font-extrabold text-white">Pick a playlist to cast off</div>
                    </div>
                    <SpeakerChip speaker={speaker} onPick={onPickSpeaker} />
                </div>
            </section>
        );
    }

    const showProgress = duration > 0;
    const clamped = showProgress ? Math.min(Math.max(smoothTime, 0), duration) : 0;
    const remaining = Math.max(0, duration - clamped);
    const pct = showProgress ? (clamped / duration) * 100 : 0;

    return (
        <section className="relative overflow-hidden rounded-3xl border border-sky-400/20 bg-slate-900/80 shadow-2xl">
            {/* Ambient backdrop — the artwork itself, blurred into the deep */}
            {showRemote && (
                <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
                    <img
                        src={artworkUrl}
                        alt=""
                        className="h-full w-full scale-125 object-cover opacity-35 blur-2xl saturate-150"
                    />
                    <div className="absolute inset-0 bg-linear-to-b from-slate-950/40 via-slate-950/60 to-slate-950/85" />
                </div>
            )}
            <div className="relative p-4">
                <div className="flex items-center gap-3.5">
                    {showRemote ? (
                        <SafeImage
                            src={artworkUrl}
                            alt=""
                            className="h-24 w-24 shrink-0 rounded-2xl object-cover shadow-2xl ring-1 ring-white/20"
                            loading="eager"
                            onError={() => setImageFailed(true)}
                            fallback={
                                <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/20">
                                    <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
                                </div>
                            }
                        />
                    ) : (
                        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/20">
                            <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-sky-200/70">
                            <span className={`h-1.5 w-1.5 rounded-full ${isPlaying ? 'bg-sky-400' : 'bg-slate-500'}`} />
                            {isPlaying ? 'Now playing' : 'Paused'}
                            {playlistName && (
                                <span className="truncate font-bold normal-case tracking-normal text-slate-400">
                                    · {playlistName}
                                </span>
                            )}
                        </div>
                        <div className="mt-1 truncate text-lg font-extrabold leading-tight text-white">
                            {nowPlaying.title}
                        </div>
                        {nowPlaying.artist && (
                            <div className="mt-0.5 truncate text-[13px] font-medium text-slate-300/80">
                                {nowPlaying.artist}
                            </div>
                        )}
                    </div>
                </div>

                {showProgress && (
                    <div
                        className="mt-3.5 flex items-center gap-2 text-[10px] font-mono tabular-nums text-slate-400"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(duration)}
                        aria-valuenow={Math.round(clamped)}
                        aria-label={`Playback progress — ${formatPlaybackTime(clamped)} of ${formatPlaybackTime(duration)}`}
                    >
                        <span className="w-8 text-right">{formatPlaybackTime(clamped)}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                            <div
                                className="h-full rounded-full bg-linear-to-r from-sky-500 to-sky-300 transition-[width] duration-150 ease-linear"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <span className="w-10 text-left">-{formatPlaybackTime(remaining)}</span>
                    </div>
                )}

                {/* Transport — big, centred, thumb-first. The speaker chip
                    used to ride shotgun in a fixed 4.5 rem slot on this row —
                    but the chip runs up to 10 rem wide (icon + name), so
                    justify-end overflowed it LEFT, straight over the Next
                    button (Shane 2026-08-11: "it is covering up the forward
                    button"). It now sits on its own line below, tucked into
                    the corner where there is nothing to shadow. */}
                <div className="mt-3 flex items-center justify-center gap-4">
                    <button
                        onClick={onPrevious}
                        className="flex h-12 w-12 items-center justify-center rounded-full text-slate-200 transition-all hover:bg-white/8 active:scale-90"
                        aria-label="Previous"
                    >
                        <SkipPrevIcon className="h-6 w-6" />
                    </button>
                    {isPlaying ? (
                        <button
                            onClick={onPause}
                            className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-500 text-white shadow-2xl shadow-sky-500/30 transition-transform active:scale-90"
                            aria-label="Pause"
                        >
                            <PauseIcon className="h-6 w-6" />
                        </button>
                    ) : (
                        <button
                            onClick={onResume}
                            className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-500 text-white shadow-2xl shadow-sky-500/30 transition-transform active:scale-90"
                            aria-label="Play"
                        >
                            <PlayIcon className="ml-0.5 h-6 w-6" />
                        </button>
                    )}
                    <button
                        onClick={onNext}
                        className="flex h-12 w-12 items-center justify-center rounded-full text-slate-200 transition-all hover:bg-white/8 active:scale-90"
                        aria-label="Next"
                    >
                        <SkipNextIcon className="h-6 w-6" />
                    </button>
                </div>
                <div className="-mb-1 -mr-1 mt-1.5 flex justify-end">
                    <SpeakerChip speaker={speaker} onPick={onPickSpeaker} />
                </div>
            </div>
        </section>
    );
};
