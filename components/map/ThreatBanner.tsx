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
 *   - Cyclones:  ActiveCyclone[] passed in from MapHub.
 *               Banner shows nearest cyclone if within 600 NM.
 *
 * Single banner — most-severe threat wins. Lightning beats cyclone if
 * lightning is within 25 NM; otherwise cyclone (if any) takes the slot.
 *
 * Hidden when no threats. Updates every 10 seconds for lightning
 * (granular), every 60s for cyclones (slow-moving).
 */
import React, { useEffect, useRef, useState } from 'react';
import { subscribeLightningStrikes, type LightningStrike } from '../../services/weather/api/blitzortungLightning';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { triggerHaptic } from '../../utils/system';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';

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

// ── Geo helpers ─────────────────────────────────────────────────────

function compass(bearing: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(bearing / 45) % 8];
}

// ── Component ───────────────────────────────────────────────────────

export const ThreatBanner: React.FC<ThreatBannerProps> = ({
    visible,
    userLat,
    userLon,
    cyclones,
    lightningActive,
    flyTo,
}) => {
    const [threat, setThreat] = useState<Threat | null>(null);

    // Lightning strike buffer — keep a rolling 5-min window of strikes
    // so we can re-evaluate proximity each tick without re-summing.
    const strikesRef = useRef<Map<string, LightningStrike>>(new Map());
    // Latest position and cyclone list for the evaluator, read at tick time.
    // They used to be effect deps, so every GPS fix (1 Hz) tore the 10 s
    // interval down and re-ran evaluate() — defeating the throttle the
    // comment below describes.
    const posRef = useRef({ lat: userLat, lon: userLon });
    const cyclonesRef = useRef(cyclones);
    useEffect(() => {
        posRef.current = { lat: userLat, lon: userLon };
        cyclonesRef.current = cyclones;
    }, [userLat, userLon, cyclones]);

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
                        label: `⚡ Lightning · ${distNm.toFixed(0)} NM ${compass(bearing)}`,
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
                if (nearestCyclone && nearestNm <= RADIUS_CYCLONE_NM) {
                    const distNm = nearestNm;
                    const bearing = calculateBearing(
                        hereLat,
                        hereLon,
                        nearestCyclone.currentPosition.lat,
                        nearestCyclone.currentPosition.lon,
                    );
                    const severity: Threat['severity'] = distNm < 100 ? 'danger' : distNm < 300 ? 'warning' : 'caution';
                    const cat = nearestCyclone.categoryLabel ?? nearestCyclone.category ?? '?';
                    const winds = nearestCyclone.maxWindKts ?? nearestCyclone.currentPosition.windKts;
                    cycloneThreat = {
                        kind: 'cyclone',
                        distanceNm: distNm,
                        bearing,
                        severity,
                        label: `🌀 ${nearestCyclone.name || 'Tropical system'} · ${distNm.toFixed(0)} NM ${compass(bearing)}`,
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
    }, [visible, lightningActive]);

    if (!visible || !threat) return null;

    // Severity → colour scheme
    const severityStyle: Record<Threat['severity'], { border: string; text: string; pulse: boolean }> = {
        caution: { border: 'rgba(251, 191, 36, 0.5)', text: '#fcd34d', pulse: false }, // amber
        warning: { border: 'rgba(249, 115, 22, 0.6)', text: '#fdba74', pulse: false }, // orange
        danger: { border: 'rgba(239, 68, 68, 0.7)', text: '#fca5a5', pulse: true }, // red
    };
    const sev = severityStyle[threat.severity];

    return (
        <button
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
                background: 'rgba(15, 23, 42, 0.92)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: `1px solid ${sev.border}`,
                borderRadius: 14,
                padding: '8px 14px',
                color: 'rgba(255,255,255,0.92)',
                boxShadow: `0 8px 24px rgba(0,0,0,0.5), 0 0 16px ${sev.border}`,
                animation: sev.pulse ? 'threat-pulse 2.4s ease-in-out infinite' : undefined,
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
