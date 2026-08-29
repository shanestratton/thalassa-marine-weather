/**
 * The switch for the boat's always-on track.
 *
 * Shane 2026-08-30: "we need a toggle in the settings that kicks it off so that
 * the pi starts doing it."
 *
 * The Pi does the recording; this only asks it to start or stop and reports
 * what it holds. It is deliberately honest about three different states that a
 * naive switch would collapse into one:
 *
 *   not reachable  — we could not ask. NOT the same as "off": showing a
 *                    confident OFF for a sleeping Pi would invite a skipper to
 *                    "turn on" something that has been recording all along.
 *   on, running    — the loop is alive.
 *   on, not running — asked for, but the loop is not going. Worth seeing rather
 *                    than hiding behind a happy-looking switch.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { getPiTrackStatus, setPiTrackRecording, type PiTrackStatus } from '../../services/piTrackRecorder';
import { triggerHaptic } from '../../utils/system';

function human(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function span(firstMs: number | null, lastMs: number | null): string | null {
    if (firstMs === null || lastMs === null) return null;
    const days = Math.max(0, Math.round((lastMs - firstMs) / 86_400_000));
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} of track`;
    const hours = Math.max(0, Math.round((lastMs - firstMs) / 3_600_000));
    return hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'} of track` : 'less than an hour of track';
}

export const PiTrackRecorderCard: React.FC = () => {
    const [status, setStatus] = useState<PiTrackStatus | null>(null);
    const [asked, setAsked] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        setStatus(await getPiTrackStatus());
        setAsked(true);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const toggle = useCallback(async () => {
        if (busy || !status) return;
        setBusy(true);
        triggerHaptic('light');
        try {
            setStatus((await setPiTrackRecording(!status.enabled)) ?? null);
        } finally {
            setBusy(false);
        }
    }, [busy, status]);

    // Say nothing at all until we have asked once. A card that flashes
    // "unavailable" on every open is noise.
    if (!asked) return null;

    if (!status) {
        return (
            <div
                data-testid="pi-track-card"
                className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-1"
            >
                <p className="text-[11px] font-bold uppercase tracking-wider text-white/70">Boat track recorder</p>
                <p className="text-[11px] text-amber-300/80">
                    Can’t reach the Pi — this doesn’t mean recording is off, only that it can’t be asked right now.
                </p>
            </div>
        );
    }

    const held = span(status.stored.firstMs, status.stored.lastMs);

    return (
        <div
            data-testid="pi-track-card"
            className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-2"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-white/70">Boat track recorder</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-gray-400">
                        The Pi keeps the boat’s track on its own, whether or not the app is running.
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={status.enabled}
                    aria-label="Boat track recorder"
                    onClick={() => void toggle()}
                    disabled={busy}
                    className={`shrink-0 min-h-[44px] px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all disabled:opacity-50 ${
                        status.enabled
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-white/5 border-white/10 text-white/60'
                    }`}
                >
                    {busy ? '…' : status.enabled ? 'Recording' : 'Off'}
                </button>
            </div>

            <p className="text-[11px] font-mono text-gray-400">
                {status.stored.points.toLocaleString()} points
                {held ? ` · ${held}` : ''} · {human(status.stored.bytes)}
            </p>

            {/* Asked for, but not actually going. The one state a plain switch
                would hide, and the one worth knowing about. */}
            {status.enabled && !status.running && (
                <p className="text-[11px] text-amber-300/80">Switched on, but the recorder isn’t running.</p>
            )}
        </div>
    );
};
