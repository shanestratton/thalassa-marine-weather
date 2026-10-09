/**
 * SoundingSheet — a point sounding from ECMWF's upper air (build 125, SND).
 *
 * Opened from the Obs tap-a-point bubble, never on its own: the skew-T for
 * the nearest 0.25° grid point, an hour picker (now, then every third hour
 * to 72 h), one plain sentence and six readings each with its number, in the
 * skipper's units. The look is the mock-up Shane approved on 2026-10-09.
 *
 * Honest by construction: it says how coarse seven levels are, credits ECMWF
 * (a CC BY 4.0 condition), and has three distinct ways of saying "no
 * sounding" — not available here, the server needs its next update, or a
 * failure with a retry. Centred and clear of the tab bar per the house modal
 * rule; the diagram takes whatever height is left, so the sheet fits one
 * screen down to 320 × 568 without scrolling.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { UnitPreferences } from '../../types/units';
import { fetchSounding, wrapLongitude, type SoundingFetch } from '../../services/weather/sounding/soundingData';
import {
    describeSounding,
    formatSoundingTime,
    formatUtcOffset,
    hourChoices,
    utcOffsetAt,
} from '../../services/weather/sounding/soundingReadings';
import { SkewTChart } from './SkewTChart';
import './soundingSheet.css';

export type SoundingPalette = 'day' | 'dark' | 'night';

export interface SoundingSheetProps {
    lat: number;
    lon: number;
    units?: Partial<UnitPreferences>;
    palette: SoundingPalette;
    /** The spot's saved name, when it has one. */
    placeName?: string | null;
    onClose: () => void;
}

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;

/** The slot's pixel size, so the diagram is drawn at it (a fallback where nothing measures). */
function useSlotSize(ref: React.RefObject<HTMLDivElement | null>, active: boolean) {
    const [size, setSize] = useState({ w: 300, h: 240 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !active) return;
        const read = () => {
            const w = Math.floor(el.clientWidth);
            const h = Math.floor(el.clientHeight);
            if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
        };
        read();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(read);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref, active]);
    return size;
}

export const SoundingSheet: React.FC<SoundingSheetProps> = ({ lat, lon, units, palette, placeName, onClose }) => {
    const [result, setResult] = useState<SoundingFetch | null>(null);
    const [hour, setHour] = useState(0);
    const closeRef = useRef<HTMLButtonElement>(null);
    const chartRef = useRef<HTMLDivElement>(null);
    const chipsRef = useRef<HTMLDivElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: closeRef, onEscape: onClose });

    const load = useCallback(() => {
        let live = true;
        setResult(null);
        void fetchSounding(lat, lon).then((outcome) => {
            if (live) setResult(outcome);
        });
        return () => {
            live = false;
        };
    }, [lat, lon]);
    useEffect(() => load(), [load]);

    const data = result?.status === 'ok' ? result.data : null;
    const choices = useMemo(() => (data ? hourChoices(data) : []), [data]);
    // Open on the first hour there is enough of to draw (now, almost always).
    useEffect(() => {
        setHour(choices.find((c) => c.available)?.index ?? 0);
    }, [choices]);
    const report = useMemo(() => (data ? describeSounding(data, hour, units ?? {}) : null), [data, hour, units]);
    const size = useSlotSize(chartRef, !!report);

    // Keep the chosen hour's chip in view as the picker scrolls.
    useEffect(() => {
        chipsRef.current
            ?.querySelector<HTMLElement>('[aria-pressed="true"]')
            ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [hour, choices]);

    const speedUnit = units?.speed ?? 'kts';
    const tempUnit = units?.temp ?? 'C';
    // A tap past the antimeridian arrives as 186°E: the header names the real place, 174°W.
    const where = data
        ? `${coord(data.lat, 'N', 'S')} ${coord(data.lon, 'E', 'W')}`
        : `${coord(lat, 'N', 'S')} ${coord(wrapLongitude(lon), 'E', 'W')}`;
    // The offset at the chosen hour: it changes when the clocks do.
    const when = data ? `${formatSoundingTime(data, hour)} (${formatUtcOffset(utcOffsetAt(data, hour))})` : '';
    const lidText = data && Math.abs(data.lat) <= 30 ? 'trade lid (dry above)' : 'dry lid';

    let notice: React.ReactNode = null;
    if (!result) notice = <p className="snd-notice">Reading the upper air…</p>;
    else if (result.status === 'unavailable')
        notice = <p className="snd-notice">Upper-air data isn’t available for this point right now.</p>;
    else if (result.status === 'needs-update')
        notice = (
            <p className="snd-notice">Soundings need the next server update. The rest of the forecast is unaffected.</p>
        );
    else if (result.status === 'error')
        notice = (
            <>
                <p className="snd-notice">Couldn’t load the sounding. Check the connection and try again.</p>
                <button type="button" className="snd-retry" onClick={load}>
                    Try again
                </button>
            </>
        );
    else if (!report)
        notice = (
            <p className="snd-notice">
                {choices.some((c) => c.available)
                    ? 'Too few levels at this hour to draw a sounding.'
                    : 'Too few levels in this forecast to draw a sounding.'}
            </p>
        );

    return (
        <div
            data-sounding-overlay=""
            data-palette={palette}
            className="snd-overlay fixed inset-0 z-10050 flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            role="presentation"
            onClick={onClose}
        >
            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sounding-title"
                className="snd-sheet"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="snd-head">
                    <div className="snd-title-row">
                        <h2 id="sounding-title">Sounding</h2>
                        <span className="snd-where">{where}</span>
                    </div>
                    <p className="snd-sub" data-testid="sounding-when">
                        {placeName ? `${placeName} · ` : ''}
                        {when || 'ECMWF upper air'}
                    </p>
                    {/* `absolute` beside hit-target-44, whose own rule would otherwise make it relative. */}
                    <button
                        ref={closeRef}
                        type="button"
                        className="snd-close absolute hit-target-44"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                            <path d="M1 1l10 10M11 1L1 11" />
                        </svg>
                    </button>
                </div>

                {/* The picker stays whenever there is data, so an hour too thin to draw is never a dead end. */}
                {data && (
                    <div className="snd-hours" ref={chipsRef} role="group" aria-label="Forecast hour">
                        {choices.map((c) => (
                            <button
                                key={c.index}
                                type="button"
                                data-hour-chip=""
                                className="snd-chip hit-target-44"
                                // "15:00" comes round every day: the full time tells them apart.
                                aria-label={c.index === 0 ? undefined : formatSoundingTime(data, c.index)}
                                aria-pressed={c.index === hour}
                                disabled={!c.available}
                                onClick={() => setHour(c.index)}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                )}
                {report && (
                    <>
                        <p className="snd-headline" data-testid="sounding-headline">
                            {report.headline}
                        </p>
                        <div className="snd-chart" ref={chartRef}>
                            <SkewTChart
                                profile={report.profile}
                                width={size.w}
                                height={size.h}
                                speedUnit={speedUnit}
                                tempUnit={tempUnit}
                                cloudBaseText={report.cloudBaseLabel}
                                lidText={lidText}
                                southern={(data?.lat ?? lat) < 0}
                            />
                        </div>
                        <div className="snd-legend" aria-hidden="true">
                            {(
                                [
                                    ['snd-temp', 'Temperature'],
                                    ['snd-dew', 'Dewpoint'],
                                    ['snd-parcel', 'Rising air'],
                                ] as const
                            ).map(([cls, name]) => (
                                <span key={cls}>
                                    <svg width="13" height="6" viewBox="0 0 13 6">
                                        <line className={cls} x1="1" x2="12" y1="3" y2="3" />
                                    </svg>
                                    {name}
                                </span>
                            ))}
                        </div>
                        <dl className="snd-rows">
                            {report.readings.map((r) => (
                                <div key={r.key} className={`snd-row snd-row-${r.key}`}>
                                    <dt>{r.label}</dt>
                                    <dd>{r.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </>
                )}
                {notice && (
                    <div role="status" className="snd-state">
                        {notice}
                    </div>
                )}

                {/* The readings name the skipper's unit; only the barbs keep to knots, which each
                    barb's own title says too, so a short screen can drop the note. */}
                <p className="snd-foot" data-testid="sounding-credit">
                    ECMWF IFS 0.25°, 7 levels: coarse, not an aviation sounding.
                    {speedUnit === 'kts' ? '' : <span className="snd-only-tall"> Barbs in knots.</span>} Forecast data:
                    ECMWF.
                </p>
            </div>
        </div>
    );
};

export default SoundingSheet;
