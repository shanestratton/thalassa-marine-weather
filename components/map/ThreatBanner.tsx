/**
 * ThreatBanner — proximity-aware threat alert for the chart screen.
 *
 * When something dangerous is within sight of the boat — recent
 * lightning strikes within ~50 NM, an active tropical cyclone within
 * a few hundred NM — a banner pops up at the top of the chart
 * showing what it is, how far it is, and its bearing. Tap it to fly
 * the map to the threat.
 *
 * This is the safety feature competitors don't have. Marine apps
 * either show ALL the data or NONE of it; nothing surfaces the
 * "thing you should be looking at right now". The banner answers
 * the most operationally important question on the chart screen:
 * "is anything trying to kill me, and if so, where is it?".
 *
 * Sources surfaced:
 *   - Lightning: subscribeLightningStrikes (live WebSocket feed)
 *               Counts strikes within RADIUS_NM in the last 5 min;
 *               banner shows nearest strike's bearing + distance.
 *               OFF behind the Blitzortung licence flag (default since
 *               build 123): their terms forbid storm-warning use, so with
 *               the flag off the banner never counts a strike.
 *   - Cyclones:  ActiveCyclone[] passed in from MapHub.
 *               Banner shows nearest cyclone if within 600 NM.
 *
 * Single banner — most-severe threat wins. Lightning beats cyclone if
 * lightning is within 25 NM; otherwise cyclone (if any) takes the slot.
 *
 * Hidden when no threats. Updates every 10 seconds for lightning
 * (granular), every 60s for cyclones (slow-moving).
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { subscribeLightningStrikes, type LightningStrike } from '../../services/weather/api/blitzortungLightning';
import { isBlitzortungEnabled } from '../../services/weather/api/lightningLicence';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { triggerHaptic } from '../../utils/system';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import { compassPoint, stormDistance } from './stormWords';

interface ThreatBannerProps {
    visible: boolean;
    userLat: number;
    userLon: number;
    /** Cyclones from MapHub. Pass [] when cyclone data isn't loaded. */
    cyclones: ActiveCyclone[];
    /** Whether the user has the lightning layer active — banner only
     *  surfaces lightning threats when the user has explicitly opted
     *  into that data, since it's a continuous WebSocket feed. */
    lightningActive: boolean;
    /** Fly the map to a (lat, lon, zoom). Banner taps invoke this. */
    flyTo: (lat: number, lon: number, zoom: number) => void;
    /** Told whether the banner is on screen, so Obs's position message can sit below it. */
    onShowingChange?: (showing: boolean) => void;
    /**
     * The storm the open storm card shows (129-13). Its distance is on the
     * card, so the chip stands aside for it rather than sitting on the
     * card's header; a different, nearer storm still gets the chip.
     */
    stormCardSid?: string | null;
}

interface Threat {
    kind: 'lightning' | 'cyclone';
    distanceNm: number;
    bearing: number; // 0..360
    severity: 'caution' | 'warning' | 'danger';
    /** Display label, e.g. "12 strikes/min · 8 NM SE". */
    label: string;
    /** Subtitle, e.g. "Lightning · last 5 min". */
    sublabel: string;
    /** Where to fly the map on tap. */
    target: { lat: number; lon: number; zoom: number };
    /** Stable id for animation key. */
    id: string;
}

const RADIUS_LIGHTNING_NM = 50; // beyond this, no banner for lightning
const RADIUS_CYCLONE_NM = 600;
const STRIKE_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 10_000; // re-evaluate threats every 10s

/** "8 NM SE", with no-break spaces: "NM W" never wraps onto a line of its own (129-13). */
function nmAway(nm: number, bearing: number): string {
    return `${nm.toFixed(0)}\u00a0NM\u00a0${compassPoint(bearing)}`;
}

/**
 * The chip's bottom edge, for the storm card under it (index.css
 * .storm-hud-badges): set on the chart's own box while the chip shows, so
 * the two are one measured stack and never overlap (129-13).
 */
const CHIP_BOTTOM_VAR = '--thalassa-threat-chip-bottom';

// ── Component ───────────────────────────────────────────────────────

export const ThreatBanner: React.FC<ThreatBannerProps> = ({
    visible,
    userLat,
    userLon,
    cyclones,
    lightningActive: lightningRequested,
    flyTo,
    onShowingChange,
    stormCardSid = null,
}) => {
    // Flag first, so a build with the Blitzortung flag off drops the strike feed.
    const lightningActive = isBlitzortungEnabled() && lightningRequested;
    const [threat, setThreat] = useState<Threat | null>(null);
    const showing = visible && threat !== null;
    useEffect(() => {
        onShowingChange?.(showing);
    }, [showing, onShowingChange]);
    useEffect(() => () => onShowingChange?.(false), [onShowingChange]);

    // Lightning strike buffer — keep a rolling 5-min window of strikes
    // so we can re-evaluate proximity each tick without re-summing.
    const strikesRef = useRef<Map<string, LightningStrike>>(new Map());
    // Latest position and cyclone list for the evaluator, read at tick time.
    // They used to be effect deps, so every GPS fix (1 Hz) tore the 10 s
    // interval down and re-ran evaluate() — defeating the throttle the
    // comment below describes.
    const posRef = useRef({ lat: userLat, lon: userLon });
    const cyclonesRef = useRef(cyclones);
    const stormCardSidRef = useRef(stormCardSid);
    useEffect(() => {
        posRef.current = { lat: userLat, lon: userLon };
        cyclonesRef.current = cyclones;
    }, [userLat, userLon, cyclones]);
    stormCardSidRef.current = stormCardSid;
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Subscribe to lightning when active. Strikes go straight into the
    // ref; the periodic effect below recomputes the banner from them.
    useEffect(() => {
        if (!lightningActive) {
            strikesRef.current.clear();
            return;
        }
        const unsub = subscribeLightningStrikes((s) => {
            strikesRef.current.set(s.id, s);
        });
        return unsub;
    }, [lightningActive]);

    // Re-evaluate threats periodically. Doing it on a timer instead of
    // per-strike means we don't thrash React state during a heavy storm
    // (200 strikes/min would mean 200 re-renders/min otherwise).
    useEffect(() => {
        if (!visible) {
            setThreat(null);
            return;
        }
        const evaluate = () => {
            const { lat: hereLat, lon: hereLon } = posRef.current;
            if (!isFinite(hereLat) || !isFinite(hereLon)) return;
            const activeCyclones = cyclonesRef.current;
            // 1. Lightning proximity
            let lightningThreat: Threat | null = null;
            if (lightningActive) {
                const cutoff = Date.now() - STRIKE_WINDOW_MS;
                let nearestNm = Infinity;
                let nearestStrike: LightningStrike | null = null;
                let countWithin = 0;
                for (const s of strikesRef.current.values()) {
                    if (s.time < cutoff) {
                        strikesRef.current.delete(s.id);
                        continue;
                    }
                    const nm = calculateDistance(hereLat, hereLon, s.lat, s.lon);
                    if (nm <= RADIUS_LIGHTNING_NM) {
                        countWithin++;
                        if (nm < nearestNm) {
                            nearestNm = nm;
                            nearestStrike = s;
                        }
                    }
                }
                if (nearestStrike && countWithin > 0) {
                    const distNm = nearestNm;
                    const bearing = calculateBearing(hereLat, hereLon, nearestStrike.lat, nearestStrike.lon);
                    const severity: Threat['severity'] = distNm < 5 ? 'danger' : distNm < 15 ? 'warning' : 'caution';
                    lightningThreat = {
                        kind: 'lightning',
                        distanceNm: distNm,
                        bearing,
                        severity,
                        label: `⚡ Lightning · ${nmAway(distNm, bearing)}`,
                        sublabel:
                            countWithin > 1
                                ? `${countWithin} strikes nearby in last 5 min`
                                : 'One strike in last 5 min',
                        target: { lat: nearestStrike.lat, lon: nearestStrike.lon, zoom: 8 },
                        id: `lightning-${nearestStrike.id}`,
                    };
                }
            }

            // 2. Cyclone proximity
            let cycloneThreat: Threat | null = null;
            if (activeCyclones && activeCyclones.length > 0) {
                let nearestNm = Infinity;
                let nearestCyclone: ActiveCyclone | null = null;
                for (const c of activeCyclones) {
                    const lat = c.currentPosition?.lat;
                    const lon = c.currentPosition?.lon;
                    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
                    const nm = calculateDistance(hereLat, hereLon, lat, lon);
                    if (nm < nearestNm) {
                        nearestNm = nm;
                        nearestCyclone = c;
                    }
                }
                // The open storm card already says how far this one is.
                const onTheCard = nearestCyclone !== null && nearestCyclone.sid === stormCardSidRef.current;
                if (nearestCyclone && nearestNm <= RADIUS_CYCLONE_NM && !onTheCard) {
                    const distNm = nearestNm;
                    const away = stormDistance(
                        hereLat,
                        hereLon,
                        nearestCyclone.currentPosition.lat,
                        nearestCyclone.currentPosition.lon,
                    );
                    const bearing = away?.bearing ?? 0;
                    const severity: Threat['severity'] = distNm < 100 ? 'danger' : distNm < 300 ? 'warning' : 'caution';
                    const cat = nearestCyclone.categoryLabel ?? nearestCyclone.category ?? '?';
                    const winds = nearestCyclone.maxWindKts ?? nearestCyclone.currentPosition.windKts;
                    cycloneThreat = {
                        kind: 'cyclone',
                        distanceNm: distNm,
                        bearing,
                        severity,
                        label: `🌀 ${nearestCyclone.name || 'Tropical system'} · ${nmAway(distNm, bearing)}`,
                        sublabel: `Cat ${cat}${winds ? ` · ${winds} kt winds` : ''}`,
                        target: {
                            lat: nearestCyclone.currentPosition.lat,
                            lon: nearestCyclone.currentPosition.lon,
                            zoom: 6,
                        },
                        id: `cyclone-${nearestCyclone.sid}`,
                    };
                }
            }

            // 3. Pick winner — lightning beats cyclone when lightning is
            //    inside 25 NM (immediate danger), cyclone otherwise.
            let winner: Threat | null = null;
            if (lightningThreat && lightningThreat.distanceNm < 25) {
                winner = lightningThreat;
            } else if (cycloneThreat) {
                winner = cycloneThreat;
            } else if (lightningThreat) {
                winner = lightningThreat;
            }

            setThreat((prev) => {
                // Haptic on threat APPEAR or escalation, not on every tick.
                if (!prev && winner) {
                    triggerHaptic(winner.severity === 'danger' ? 'heavy' : 'medium');
                } else if (prev && winner && prev.severity !== winner.severity && winner.severity === 'danger') {
                    triggerHaptic('heavy');
                }
                return winner;
            });
        };
        evaluate();
        const t = setInterval(evaluate, REFRESH_INTERVAL_MS);
        return () => clearInterval(t);
    }, [visible, lightningActive, stormCardSid]);

    // One measured stack with the storm card (129-13): the chip's bottom edge,
    // in the chart's own box, while it shows; nothing once it is gone.
    useLayoutEffect(() => {
        const el = buttonRef.current;
        const hub = el?.closest<HTMLElement>('[data-testid="map-hub"]');
        if (!el || !hub) return undefined;
        const publish = () => {
            const bottom = el.getBoundingClientRect().bottom - hub.getBoundingClientRect().top;
            hub.style.setProperty(CHIP_BOTTOM_VAR, `${Math.ceil(bottom)}px`);
        };
        publish();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
        observer?.observe(el);
        window.addEventListener('resize', publish);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', publish);
            hub.style.removeProperty(CHIP_BOTTOM_VAR);
        };
    }, [showing, threat?.id]);

    if (!visible || !threat) return null;

    // Severity → colour scheme
    const severityStyle: Record<Threat['severity'], { border: string; text: string; pulse: boolean }> = {
        caution: { border: 'rgba(251, 191, 36, 0.5)', text: 'var(--day-ui-amber, #fcd34d)', pulse: false }, // amber
        warning: { border: 'rgba(249, 115, 22, 0.6)', text: 'var(--day-ui-orange, #fdba74)', pulse: false }, // orange
        danger: { border: 'rgba(239, 68, 68, 0.7)', text: 'var(--day-ui-danger, #fca5a5)', pulse: true }, // red
    };
    const sev = severityStyle[threat.severity];

    return (
        <button
            ref={buttonRef}
            // A storm or strike under 100 NM stays in the clear view (129-13).
            data-clear-view-keep={threat.severity === 'danger' ? '' : undefined}
            data-threat-chip=""
            onClick={() => {
                triggerHaptic('light');
                flyTo(threat.target.lat, threat.target.lon, threat.target.zoom);
            }}
            // z-805 — sits in the top-center stack just below the
            // ChartModes chip (z-[800]) and LayerSettings sheet (z-[810]),
            // above the right-rail FABs (z-[700]). Whole top-center
            // cluster is now in the 800-tier so map layers + right-rail
            // expanded menus can never obscure these primary surfaces.
            className="fixed left-1/2 chart-chip-centered z-805 flex items-center gap-3 text-left transition-all chart-chip-in"
            style={{
                top: 'max(58px, calc(env(safe-area-inset-top) + 56px))', // sits below the modes chip
                background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.92))',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: `1px solid ${sev.border}`,
                borderRadius: 14,
                padding: '8px 14px',
                color: 'var(--day-ui-text, rgba(255,255,255,0.92))',
                boxShadow: `0 8px 24px rgba(0,0,0,0.5), 0 0 16px ${sev.border}`,
                animation: sev.pulse ? 'threat-pulse 2.4s ease-in-out infinite' : undefined,
                // max-content: at left 50% a shrink-to-fit box gets only half the
                // screen, which is why "W" wrapped onto a line of its own at 390
                // (Shane 2026-10-14). Now it is as wide as its words, up to the gutters.
                width: 'max-content',
                maxWidth: 'calc(100vw - 32px)',
            }}
            aria-label={`Threat alert: ${threat.label}`}
        >
            <div className="flex flex-col">
                <span className="font-bold text-sm leading-tight" style={{ color: sev.text }}>
                    {threat.label}
                </span>
                <span className="opacity-90 text-xs leading-tight">{threat.sublabel}</span>
            </div>
            <span className="opacity-60 text-xs ml-1" aria-hidden>
                ▸
            </span>
        </button>
    );
};
