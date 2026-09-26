import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { XIcon } from '../Icons';
import { analyzeRain, getIntensityLabel, type RainAnalysis } from './rainAnalysis';

interface MinutelyRain {
    time: string;
    intensity: number; // mm/hr
}

interface RainForecastCardProps {
    data: MinutelyRain[];
    className?: string;
    timeZone?: string;
    rainSummary?: string; // Apple's native summary (e.g. "Rain starting in 15 min")
    /** Which API delivered `data` — shown as a tiny provenance tag. */
    source?: 'rainbow' | 'weatherkit' | 'synthetic' | 'unknown';
    /**
     * Whether the minutely fetch has resolved, and how.
     *
     * Without this the card cannot tell "the forecast says it will stay dry"
     * from "we have no forecast", and an empty array rendered as the
     * confident headline NO RAIN EXPECTED. Offline that was permanent:
     * Dashboard's offline path sets minutelyRain to [] and status 'error',
     * so a skipper out of coverage got a dry verdict that never changed.
     */
    status?: 'loading' | 'loaded' | 'error';
}

/**
 * RainForecastCard — Progressive Disclosure Rain Component
 *
 * Compact State: Small card with summary text. "Wakes up" with cyan glow when rain detected.
 * Expanded State: Full modal with Dark Sky-style 60-bar minute-by-minute precipitation chart.
 */
export const RainForecastCard: React.FC<RainForecastCardProps> = ({
    data,
    className = '',
    timeZone: _timeZone,
    rainSummary,
    source = 'unknown',
    status = 'loaded',
}) => {
    // Label text for the provenance tag in the bottom-right corner.
    //
    // The vendor names are gone (Shane 2026-08-28: "get rid of the Rainbow.AI
    // wording in the bottom right of the rain card"). Which API answered is a
    // developer's question, and the card is read at a glance from a cockpit —
    // it does not need to advertise a supplier.
    //
    // "Estimated" STAYS, and is not the same kind of label. It is not naming a
    // vendor, it is warning that these numbers are modelled rather than
    // observed, and a rain forecast that hides that is the one thing this card
    // must never be. Provenance for the curious lives in the modal.
    const sourceLabel = source === 'synthetic' ? 'Estimated' : '';
    const [isModalOpen, setIsModalOpen] = useState(false);

    // 60-second tick — forces re-evaluation of "Rain in X min" countdown
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    const analysis = useMemo(
        () => analyzeRain(data, { rainSummary, status, now: Date.now() }),
        // `source` no longer feeds the analysis: the dry-verdict window is
        // computed from the live span of the remaining frames, not from the
        // provider's nominal horizon. `tick` re-evaluates every 60 s so
        // countdowns stay live and elapsed frames fall out.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [data, rainSummary, status, tick],
    );

    const openModal = useCallback(() => {
        if (analysis.frames.length > 0) {
            void triggerHaptic('light');
            setIsModalOpen(true);
        }
    }, [analysis.frames.length]);

    // If the feed expires while the modal is open (60-s tick empties frames),
    // close it rather than leave a sunny "Clear / 0.0 mm/hr" scene standing
    // on zero data.
    useEffect(() => {
        if (isModalOpen && analysis.frames.length === 0) setIsModalOpen(false);
    }, [isModalOpen, analysis.frames.length]);

    if (!analysis) return null;

    // --- COMPACT CARD (always visible) ---
    const isActive = analysis.hasRain;

    return (
        <>
            <button
                aria-label="Open rain forecast detail"
                onClick={openModal}
                // By day the card takes the metric grid's white card surface and
                // border: the translucent slate was about 1.1:1 against the
                // daylight page (UX scorecard run 6). Important, because the
                // daylight remap of bg-slate-800/40 is unlayered and would win.
                // On short portrait (Dashboard root data-glass-rhythm="short")
                // the strip is one 36 pt line so the tide card keeps its room:
                // headline, badge and any Estimated tag in a single centred row.
                className={`w-full min-h-[76px] rounded-xl overflow-hidden relative text-left transition-all duration-500 in-data-[glass-rhythm=short]:min-h-9 in-data-[glass-rhythm=short]:flex in-data-[glass-rhythm=short]:items-center in-data-[glass-rhythm=short]:justify-center [.display-light_&]:bg-white! ${className} ${
                    isActive
                        ? 'bg-sky-900/40 border border-cyan-400/30 shadow-lg shadow-cyan-500/10 [.display-light_&]:border-sky-600/50!'
                        : 'bg-slate-800/40 border border-blue-400/10 [.display-light_&]:border-slate-900/20!'
                }`}
            >
                {/* Rain glow animation when active */}
                {isActive && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                        <div className="absolute -top-8 left-1/3 w-24 h-24 bg-sky-500/10 rounded-full blur-3xl" />
                        <div className="absolute -bottom-4 right-1/4 w-16 h-16 bg-sky-500/10 rounded-full blur-2xl" />
                    </div>
                )}

                <div className="relative z-10 px-3 py-1.5 h-full flex flex-col justify-between in-data-[glass-rhythm=short]:flex-row in-data-[glass-rhythm=short]:items-center in-data-[glass-rhythm=short]:justify-center in-data-[glass-rhythm=short]:py-0">
                    {/* Header Row */}
                    <div className="flex items-center justify-center">
                        <div className="flex items-center gap-1.5">
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                className={isActive ? 'text-sky-400' : 'text-sky-400/60'}
                            >
                                <path
                                    d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                    fill="currentColor"
                                    fillOpacity={isActive ? '0.5' : '0.3'}
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </svg>
                            <span
                                className={`text-xs font-bold uppercase tracking-wider ${isActive ? 'text-sky-300' : 'text-ivory'}`}
                            >
                                {analysis.headline}
                            </span>
                        </div>

                        {isActive && (
                            <div
                                className={`px-1.5 py-0 rounded-full text-[11px] font-bold uppercase tracking-wide leading-tight ${analysis.category.badgeClass}`}
                            >
                                {analysis.category.label}
                            </div>
                        )}
                    </div>

                    {/* Mini Bar Chart (compact preview) — only show when there is meaningful rain.
                        Dropped on short portrait: the one-line strip has no room. */}
                    {analysis.frames.length > 0 && analysis.hasRain && (
                        <div className="flex items-end gap-px w-full mt-1 h-[22px] in-data-[glass-rhythm=short]:hidden">
                            {analysis.frames.map((point, i) => {
                                const normalizedHeight =
                                    analysis.maxIntensity > 0
                                        ? Math.max(
                                              (point.intensity / analysis.maxIntensity) * 100,
                                              point.intensity > 0 ? 10 : 0,
                                          )
                                        : 0;
                                const barColor = getBarColor(point.intensity, analysis.maxIntensity, isActive);

                                return (
                                    <div key={i} className="flex-1 relative" style={{ height: '100%' }}>
                                        <div
                                            className="absolute bottom-0 left-0 right-0 rounded-t-[1px]"
                                            style={{
                                                height: `${normalizedHeight}%`,
                                                background: barColor,
                                                minWidth: '1px',
                                                boxShadow: point.intensity > 0 ? `0 0 3px ${barColor}30` : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Tap hint — dropped on short portrait, where the whole
                        strip is already the button named 'Open rain forecast detail'. */}
                    {analysis.frames.length > 0 && (
                        <div className="flex items-center justify-center mt-0.5 in-data-[glass-rhythm=short]:hidden">
                            <span className="text-[11px] font-bold text-white/60 uppercase tracking-widest">
                                Tap for detail
                            </span>
                        </div>
                    )}
                </div>

                {/* Honesty tag — bottom-right, and only when the numbers are
                    estimated rather than measured. On short portrait it joins
                    the one-line row instead, so it can't sit on the headline. */}
                {sourceLabel && (
                    <span className="absolute bottom-1 right-2 in-data-[glass-rhythm=short]:static in-data-[glass-rhythm=short]:shrink-0 text-[11px] font-semibold uppercase tracking-wider text-white/50 pointer-events-none select-none">
                        {sourceLabel}
                    </span>
                )}
            </button>

            {/* Expanded Modal */}
            {isModalOpen && (
                <RainModal
                    data={analysis.frames}
                    analysis={analysis}
                    source={source}
                    onClose={() => setIsModalOpen(false)}
                />
            )}
        </>
    );
};

// --- EXPANDED MODAL ---

interface ModalProps {
    /** Future-only frames — the same array analysis.peakIdx indexes into. */
    data: MinutelyRain[];
    analysis: RainAnalysis;
    /** Which feed answered. Named here rather than on the card face. */
    source?: 'rainbow' | 'weatherkit' | 'synthetic' | 'unknown';
    onClose: () => void;
}

const RainModal: React.FC<ModalProps> = ({ data, analysis, source = 'unknown', onClose }) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    const feedProvenance = (() => {
        if (source === 'rainbow') return 'Rainbow.ai nowcast · 1 km, 4 hours ahead';
        if (source === 'weatherkit') return 'Apple WeatherKit · minute-by-minute, 1 hour ahead';
        if (source === 'synthetic') return 'Estimated from the hourly forecast — not a live rain feed';
        return null;
    })();

    // Prevent body scroll when modal is open
    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    // Time labels — derived from the ACTUAL data span, not hardcoded.
    //
    // Bug that led here: the axis was pinned at 0/15/30/45/60 minutes,
    // which only matches WeatherKit's 60-sample minutely feed. When
    // Skipper tier hits Rainbow.ai the feed is up to 240 samples over
    // 4 hours, and those pinned labels misread every bar position by
    // up to 4×. A peak visually sitting over "15M" was actually 60 min
    // away, which is exactly what the user noticed.
    //
    // Fix: read the first and last minutelyRain timestamps, compute the
    // offsets from "now" (in minutes), and place ticks at their true
    // position across that range. The ticks sit on round times — whole
    // hours on a long feed ('1 h' … '4 h'), half or quarter hours on a
    // short one — never at even fractions of the span, which printed
    // '1H59 / 2H59 / 3H58' (UX scorecard run 6). A tick within a few
    // minutes past the feed's last frame is drawn at the end, so a feed
    // reaching 3 h 58 ends at '4 h'.
    const timeLabels = React.useMemo(() => {
        if (!data || data.length === 0) {
            return [{ pct: 0, label: 'Now' }];
        }
        const now = Date.now();
        const firstMin = Math.max(0, Math.round((new Date(data[0].time).getTime() - now) / 60_000));
        const lastMin = Math.max(
            firstMin + 1,
            Math.round((new Date(data[data.length - 1].time).getTime() - now) / 60_000),
        );
        const span = lastMin - firstMin;
        const step = span >= 150 ? 60 : span > 75 ? 30 : 15;
        const endSlack = 5;
        const formatMin = (m: number): string => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

        const labels = [{ pct: 0, label: firstMin <= 2 ? 'Now' : formatMin(firstMin) }];
        for (let m = Math.ceil((firstMin + 1) / step) * step; m <= lastMin + endSlack; m += step) {
            const pct = Math.min(1, (m - firstMin) / span);
            // Too close to the first label to be read beside it.
            if (pct < 0.12) continue;
            labels.push({ pct, label: formatMin(m) });
        }
        return labels;
    }, [data]);

    return (
        <OverlayPortal className="flex items-center justify-center p-6" onClick={onClose} role="presentation">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80" />

            {/* Modal */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="rain-forecast-title"
                className="relative w-full max-w-md rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
                // Daylight gets the light day surface: the text inside already
                // inverts to navy by day, and on this navy gradient it went
                // dark-on-dark. Each var() keeps the night colour as fallback.
                style={{
                    background:
                        'var(--day-ui-surface, linear-gradient(180deg, rgb(6, 78, 115) 0%, rgb(15, 23, 42) 40%, rgb(8, 51, 96) 100%))',
                    border: '1px solid var(--day-ui-border, rgba(34, 211, 238, 0.2))',
                    boxShadow:
                        'var(--day-ui-shadow, 0 0 60px -10px rgba(34, 211, 238, 0.15), 0 25px 50px -12px rgba(0,0,0,0.5))',
                }}
            >
                {/* Weather-themed background scene.
                    Two moods: "sunny day" when no rain is expected,
                    "rain on glass" when rain is coming. Both are pure
                    SVG + gradients — no image assets, no infinite
                    animations (battery), and they sit BEHIND a z-10
                    content layer so they never interfere with
                    readability. */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
                    {!analysis.hasRain ? (
                        /* ☀️ Sunny day — warm sky gradient + prominent sun with
                            layered rays + friendly cloud puffs. Mood:
                            optimistic, clear-weather reassurance. */
                        <>
                            {/* Sky wash — sky blue at top fading to warm amber at
                                bottom, so the whole panel has a "good day"
                                tint underneath the modal's base gradient. */}
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'linear-gradient(180deg, rgba(125, 211, 252, 0.22) 0%, rgba(186, 230, 253, 0.12) 35%, rgba(253, 230, 138, 0.08) 75%, rgba(254, 215, 170, 0.05) 100%)',
                                }}
                            />
                            {/* Lens-flare glow — soft radial bloom behind the sun,
                                gives the illusion of light bleeding through. */}
                            <div
                                className="absolute top-10 right-0 w-32 h-32 rounded-full blur-2xl opacity-60"
                                style={{
                                    background:
                                        'radial-gradient(circle, rgba(253,224,71,0.7) 0%, rgba(251,191,36,0.3) 40%, rgba(251,191,36,0) 75%)',
                                }}
                            />
                            {/* Sun disc + rays — the hero element, bold enough to
                                read as a real sun but tucked into the corner so
                                the modal's data stays primary. Starts BELOW the
                                header row: at top-6 it sat behind the close
                                button and crowded it. */}
                            <svg className="absolute top-16 right-3 w-16 h-16" viewBox="0 0 100 100" aria-hidden="true">
                                <defs>
                                    <radialGradient id="sun-disc" cx="45%" cy="40%" r="55%">
                                        <stop offset="0%" stopColor="rgba(254,249,195,0.95)" />
                                        <stop offset="50%" stopColor="rgba(253,224,71,0.85)" />
                                        <stop offset="100%" stopColor="rgba(251,191,36,0.65)" />
                                    </radialGradient>
                                </defs>
                                {/* Long rays */}
                                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                                    <line
                                        key={`long-${angle}`}
                                        x1="50"
                                        y1="50"
                                        x2={50 + 42 * Math.cos((angle * Math.PI) / 180)}
                                        y2={50 + 42 * Math.sin((angle * Math.PI) / 180)}
                                        stroke="rgba(253,224,71,0.55)"
                                        strokeWidth="3"
                                        strokeLinecap="round"
                                    />
                                ))}
                                {/* Short rays offset 22.5° — fills the gaps, adds
                                    a gentle starburst feel */}
                                {[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((angle) => (
                                    <line
                                        key={`short-${angle}`}
                                        x1="50"
                                        y1="50"
                                        x2={50 + 32 * Math.cos((angle * Math.PI) / 180)}
                                        y2={50 + 32 * Math.sin((angle * Math.PI) / 180)}
                                        stroke="rgba(253,224,71,0.35)"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                    />
                                ))}
                                {/* Disc itself */}
                                <circle cx="50" cy="50" r="18" fill="url(#sun-disc)" />
                                {/* Inner highlight for 3D feel */}
                                <circle cx="44" cy="44" r="6" fill="rgba(254,249,195,0.7)" />
                            </svg>
                            {/* Secondary lens-flare blob — classic "sun-washing-
                                the-camera" effect, placed diagonally opposite
                                the sun so the eye reads it as an echo. */}
                            <div className="absolute bottom-16 left-6 w-14 h-14 rounded-full bg-yellow-200/15 blur-xl" />
                            {/* Cloud puffs — soft, friendly, anchored at the
                                bottom so they feel like a blue-sky horizon
                                reference, not a gathering storm. */}
                            <svg
                                className="absolute bottom-0 left-0 w-full opacity-70"
                                viewBox="0 0 300 80"
                                preserveAspectRatio="xMidYEnd slice"
                                aria-hidden="true"
                            >
                                <ellipse cx="50" cy="72" rx="42" ry="12" fill="rgba(255,255,255,0.10)" />
                                <ellipse cx="80" cy="68" rx="28" ry="9" fill="rgba(255,255,255,0.12)" />
                                <ellipse cx="220" cy="74" rx="50" ry="11" fill="rgba(255,255,255,0.08)" />
                                <ellipse cx="255" cy="70" rx="30" ry="8" fill="rgba(255,255,255,0.10)" />
                            </svg>
                        </>
                    ) : (
                        <>
                            {/* Rain on glass — realistic droplets with
                                highlights, shadows, and trails. Scales with
                                intensity: light rain gets ~14 drops, heavy
                                rain gets ~26 with more streaks running down.
                                Seeded pseudo-random positions so the layout
                                stays stable between renders but feels natural,
                                not gridded. */}
                            {/* Cool gray-blue wash — mimics the view out a
                                rainy window, fades top-to-bottom. */}
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'linear-gradient(180deg, rgba(71, 85, 105, 0.25) 0%, rgba(51, 65, 85, 0.15) 60%, rgba(30, 41, 59, 0.2) 100%)',
                                }}
                            />
                            {/* Subtle soft-focus cloud band at the top */}
                            <svg
                                className="absolute top-0 left-0 w-full opacity-50"
                                viewBox="0 0 300 80"
                                preserveAspectRatio="xMidYMin slice"
                                aria-hidden="true"
                            >
                                <path
                                    d="M-10 80 Q40 30 90 50 Q130 20 170 45 Q210 15 250 40 Q280 25 310 55 L310 80Z"
                                    fill="rgba(148,163,184,0.18)"
                                />
                                <path
                                    d="M-10 80 Q30 20 80 40 Q120 10 160 35 Q200 5 240 30 Q270 15 310 50 L310 80Z"
                                    fill="rgba(100,116,139,0.15)"
                                />
                            </svg>
                            {/* Rain drops on glass — v3 (matched to user's
                                windshield reference photo).
                                Previous v2 pass was perfectly round with
                                specular highlight dots — read as "beads of
                                water on a tabletop", not "rain on a
                                windshield". Real windshield drops are:
                                  - IRREGULAR teardrop / kidney shapes,
                                    slightly rotated, lots of vertical stretch
                                    from gravity pulling the drop down
                                  - DARK crescent at the top + LIGHT interior
                                    at the bottom — because the drop is an
                                    upside-down lens: dark foreground (trees,
                                    ground) flips to the top of the bead, and
                                    bright sky flips to the bottom
                                  - Sharp near-black outline all around
                                  - Densely packed (60+ beads), mixed sizes
                                    1.5–9 units, small drops dominating
                                  - No prominent specular dot — the dark-top/
                                    bright-bottom gradient IS the water tell
                            */}
                            {/* By day the dark beads sit on the light day surface,
                                under navy text: drawn fainter so they stay a
                                mood, not a pattern the numbers must fight. */}
                            <svg
                                className="absolute inset-0 w-full h-full [.display-light_&]:opacity-25"
                                viewBox="0 0 200 400"
                                preserveAspectRatio="xMidYMid slice"
                                aria-hidden="true"
                            >
                                <defs>
                                    {/* Lens gradient — dark crescent up top
                                        (inverted foreground), lighter below
                                        (inverted sky). Hard stop around 22 %
                                        gives the drop its signature "dark
                                        moon" crescent rather than a gentle
                                        fade. */}
                                    <linearGradient id="drop-lens-v3" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="rgba(8,12,22,0.95)" />
                                        <stop offset="22%" stopColor="rgba(20,28,42,0.88)" />
                                        <stop offset="40%" stopColor="rgba(71,85,105,0.55)" />
                                        <stop offset="70%" stopColor="rgba(148,163,184,0.35)" />
                                        <stop offset="100%" stopColor="rgba(226,232,240,0.55)" />
                                    </linearGradient>
                                </defs>
                                {(() => {
                                    // Dense packing — reference image has
                                    // 200+ drops visible, we'll dial to 55/90
                                    // depending on rain intensity. Past 100
                                    // we'd be rendering thousands of SVG
                                    // nodes and burning battery on low-end
                                    // phones, so this is the sweet spot.
                                    const isHeavy = analysis.maxIntensity >= 2.5;
                                    const dropCount = isHeavy ? 90 : 55;
                                    const drops: Array<{
                                        x: number;
                                        y: number;
                                        rx: number;
                                        ry: number;
                                        rot: number;
                                        hasTrail: boolean;
                                        trailLen: number;
                                    }> = [];
                                    let seed = isHeavy ? 17 : 91;
                                    const rand = () => {
                                        seed = (seed * 9301 + 49297) % 233280;
                                        return seed / 233280;
                                    };
                                    for (let i = 0; i < dropCount; i++) {
                                        // Weighted size distribution — most
                                        // drops small (1.5–3.5), some mid
                                        // (3–5.5), a few large (5–8.5). Feels
                                        // like real rain, not a grid of
                                        // identical pearls.
                                        const sizeRoll = rand();
                                        const base =
                                            sizeRoll < 0.55
                                                ? 1.5 + rand() * 2
                                                : sizeRoll < 0.88
                                                  ? 3 + rand() * 2.5
                                                  : 5 + rand() * 3.5;
                                        // Teardrop stretch — gravity pulls
                                        // drops vertically, so ry usually >
                                        // rx. Some variance to avoid uniform
                                        // stretch.
                                        const stretch = 0.85 + rand() * 0.8;
                                        drops.push({
                                            x: 4 + rand() * 192,
                                            y: 6 + rand() * 388,
                                            rx: base,
                                            ry: base * stretch,
                                            rot: (rand() - 0.5) * 40, // -20°…+20°
                                            hasTrail: base > 4.5 && rand() > 0.55,
                                            trailLen: 15 + rand() * 55,
                                        });
                                    }
                                    return drops.map((d, i) => (
                                        <g
                                            key={i}
                                            transform={`translate(${d.x.toFixed(1)} ${d.y.toFixed(1)}) rotate(${d.rot.toFixed(1)})`}
                                        >
                                            {/* Vertical trail — dark, narrow,
                                                below the bead's rotated frame.
                                                Reads as "water ran from here
                                                down the glass". */}
                                            {d.hasTrail && (
                                                <rect
                                                    x={-0.55}
                                                    y={0}
                                                    width={1.1}
                                                    height={d.trailLen}
                                                    fill="rgba(15,23,42,0.7)"
                                                    rx={0.55}
                                                />
                                            )}
                                            {/* Body — teardrop ellipse with
                                                the lens gradient. This alone
                                                does most of the heavy lifting
                                                for the "that is water" read. */}
                                            <ellipse cx={0} cy={0} rx={d.rx} ry={d.ry} fill="url(#drop-lens-v3)" />
                                            {/* Sharp dark outline — surface-
                                                tension edge. Reads clean
                                                against the panel background
                                                and locks the drop's silhouette. */}
                                            <ellipse
                                                cx={0}
                                                cy={0}
                                                rx={d.rx}
                                                ry={d.ry}
                                                fill="none"
                                                stroke="rgba(6,10,20,0.8)"
                                                strokeWidth="0.45"
                                            />
                                        </g>
                                    ));
                                })()}
                            </svg>
                        </>
                    )}
                </div>

                <div className="relative z-10 p-5">
                    {/* Header */}
                    {/* The one Glass dialog header: icon, sentence-case title,
                        top-right close (UX scorecard run 6). */}
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-sky-500/20 flex items-center justify-center">
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    className="text-sky-400"
                                    aria-hidden="true"
                                >
                                    <path
                                        d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                        fill="currentColor"
                                        fillOpacity="0.4"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                    />
                                </svg>
                            </div>
                            <h2 id="rain-forecast-title" className="text-base font-bold text-white tracking-tight">
                                Rain forecast
                            </h2>
                        </div>
                        <button
                            ref={closeButtonRef}
                            onClick={onClose}
                            className="hit-target-44 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                            aria-label="Close rain forecast detail"
                        >
                            <XIcon className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Intensity Gauge */}
                    <div className="flex flex-col items-center mb-5">
                        <div className="relative w-36 h-20">
                            <svg viewBox="0 0 120 65" className="w-full h-full overflow-visible">
                                {/* Background arc */}
                                <path
                                    d="M 10 60 A 50 50 0 0 1 110 60"
                                    fill="none"
                                    style={{ stroke: 'var(--day-ui-grid, rgba(255,255,255,0.08))' }}
                                    strokeWidth="8"
                                    strokeLinecap="round"
                                />
                                {/* Active arc — proportional to intensity */}
                                {analysis.hasRain && (
                                    <path
                                        d="M 10 60 A 50 50 0 0 1 110 60"
                                        fill="none"
                                        stroke="url(#rainGaugeGrad)"
                                        strokeWidth="8"
                                        strokeLinecap="round"
                                        strokeDasharray={`${Math.min(analysis.maxIntensity / 15, 1) * 157} 157`}
                                    />
                                )}
                                <defs>
                                    <linearGradient id="rainGaugeGrad" x1="0" y1="0" x2="1" y2="0">
                                        <stop offset="0%" stopColor="#22d3ee" />
                                        <stop offset="50%" stopColor="#3b82f6" />
                                        <stop offset="100%" stopColor="#818cf8" />
                                    </linearGradient>
                                </defs>
                                {/* Droplet icon — only with rain. At 0.0 it sat at
                                    the arc's apex and read as a needle at half
                                    scale. */}
                                {analysis.hasRain && (
                                    <path
                                        d="M 60 28 l3.5 3.5 a5 5 0 1 1 -7 0 L60 28z"
                                        fill="rgba(34, 211, 238, 0.7)"
                                        stroke="rgba(34, 211, 238, 0.9)"
                                        strokeWidth="0.5"
                                    />
                                )}
                            </svg>
                        </div>

                        {/* Intensity label */}
                        <div className="text-center -mt-2">
                            {/* text-sky-400 steps to sky-800 by day (legibility.css),
                                which holds on the light day surface below. */}
                            <div className="text-[11px] font-bold uppercase tracking-widest mb-0.5 text-sky-400">
                                {analysis.hasRain ? getIntensityLabel(analysis.maxIntensity) : 'Clear'}
                            </div>
                            <div className="text-2xl font-black text-white tabular-nums">
                                {analysis.hasRain ? analysis.maxIntensity.toFixed(1) : '0.0'}
                            </div>
                            {/* Units stay lower case: 'MM/HR' is not how the unit is written. */}
                            <div className="text-[11px] text-white/60 tracking-wider">mm/hr peak</div>
                        </div>
                    </div>

                    {/* Summary Text */}
                    <div className="text-center mb-4">
                        <p className="text-sm font-bold text-white uppercase tracking-wide">{analysis.headline}</p>
                    </div>

                    {/* 60-Bar Chart */}
                    <div className="relative">
                        {/* Peak intensity marker */}
                        {analysis.hasRain && (
                            <div
                                className="absolute -top-4 text-[11px] text-sky-400 font-bold uppercase tracking-wider whitespace-nowrap"
                                style={{
                                    left: `${(analysis.peakIdx / Math.max(data.length - 1, 1)) * 100}%`,
                                    transform: 'translateX(-50%)',
                                }}
                            >
                                Peak
                            </div>
                        )}

                        {/* Dry window: the chart collapses to a 32 pt baseline over
                            the time axis. The headline above already says there
                            is no rain; a full-height empty chart with the verdict
                            printed in it again said it a third time (UX
                            scorecard run 6). */}
                        <div
                            className={`relative flex items-end gap-[2px] w-full ${analysis.hasRain ? 'h-[120px]' : 'h-8'}`}
                        >
                            {!analysis.hasRain && (
                                <div
                                    className="absolute inset-x-0 bottom-0 h-px pointer-events-none"
                                    style={{ background: 'var(--day-ui-border, rgba(255,255,255,0.25))' }}
                                    aria-hidden="true"
                                />
                            )}
                            {data.map((point, i) => {
                                const normalizedHeight =
                                    analysis.maxIntensity > 0
                                        ? Math.max(
                                              (point.intensity / analysis.maxIntensity) * 100,
                                              point.intensity > 0 ? 8 : 0,
                                          )
                                        : 0;
                                const barColor = getBarColor(point.intensity, analysis.maxIntensity, true);
                                const isPeak = i === analysis.peakIdx && analysis.hasRain;

                                return (
                                    <div key={i} className="flex-1 relative" style={{ height: '100%' }}>
                                        <div
                                            className={`absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-300 ${isPeak ? 'ring-1 ring-cyan-400/50' : ''}`}
                                            style={{
                                                height: `${normalizedHeight}%`,
                                                background: barColor,
                                                minWidth: '2px',
                                                boxShadow:
                                                    point.intensity > 0
                                                        ? `0 0 ${isPeak ? '8' : '3'}px ${barColor}50`
                                                        : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        {/* Time Axis — labels positioned by true pct across the
                            span of the minutelyRain feed, not by fixed index.
                            Keeps bars and labels aligned regardless of whether
                            the feed covers 60 min (WeatherKit) or 4h (Rainbow). */}
                        <div className="relative mt-2 h-4">
                            {timeLabels.map(({ pct, label }, i) => (
                                <span
                                    key={`${i}-${label}`}
                                    className="absolute text-[11px] text-white/60 font-bold tracking-wide whitespace-nowrap"
                                    style={{
                                        left: `${pct * 100}%`,
                                        // Shift the first label flush-left, the
                                        // last flush-right, the rest centered —
                                        // matches how bars align to their own
                                        // flex edges.
                                        transform:
                                            pct === 0
                                                ? 'translateX(0)'
                                                : pct > 0.95
                                                  ? 'translateX(-100%)'
                                                  : 'translateX(-50%)',
                                    }}
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Stats Row */}
                    {analysis.hasRain && (
                        <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-white/10">
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Total</div>
                                <div className="text-sm font-bold text-white tabular-nums">
                                    {Math.round(analysis.totalPrecip)} mm
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Peak</div>
                                <div className="text-sm font-bold text-sky-400 tabular-nums">
                                    {Math.round(analysis.maxIntensity)} mm/hr
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Type</div>
                                <div className="text-sm font-bold text-white">{analysis.category.label}</div>
                            </div>
                        </div>
                    )}

                    {/* Which feed answered, and how far ahead it can see.
                        Off the card face and in here, where someone standing
                        in rain the card called dry comes looking for it. */}
                    {feedProvenance && (
                        <p className="mt-3 text-[10px] text-white/60 text-center leading-relaxed">{feedProvenance}</p>
                    )}
                </div>
            </div>
        </OverlayPortal>
    );
};

// --- Helpers ---
// getIntensityLabel / getIntensityCategory live in rainAnalysis.ts with the
// rest of the card's claims; getBarColor is render-only and stays here.

function getBarColor(intensity: number, maxIntensity: number, active: boolean): string {
    if (intensity === 0) return 'transparent';

    const ratio = intensity / Math.max(maxIntensity, 0.1);

    if (active) {
        // Active: cyan → blue → indigo spectrum
        if (ratio > 0.8) return 'rgba(34, 211, 238, 0.95)'; // Cyan — peak
        if (ratio > 0.6) return 'rgba(56, 189, 248, 0.85)'; // Sky
        if (ratio > 0.4) return 'rgba(96, 165, 250, 0.80)'; // Blue
        if (ratio > 0.2) return 'rgba(129, 140, 248, 0.70)'; // Indigo
        return 'rgba(147, 197, 253, 0.55)'; // Light blue
    }

    // Quiet: muted blues
    if (ratio > 0.6) return 'rgba(96, 165, 250, 0.70)';
    if (ratio > 0.3) return 'rgba(96, 165, 250, 0.50)';
    return 'rgba(96, 165, 250, 0.35)';
}

export default RainForecastCard;
