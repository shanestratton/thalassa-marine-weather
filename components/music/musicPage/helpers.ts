/** Format a millisecond duration as "m:ss" — e.g. 184_000 → "3:04". */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format seconds as M:SS / H:MM:SS. NaN/Infinity → "0:00". */
export function formatPlaybackTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}
