/**
 * SwingCircleCanvas — Premium radar-style anchor watch visualization.
 *
 * Renders a canvas with:
 * - Compass rose with cardinal labels and tick marks
 * - Color-coded zone bands (safe/caution/danger)
 * - Position history trail with gradient heat map
 * - Vessel position with glowing pulse marker
 * - GPS accuracy circle
 * - Anchor icon at center
 * - Optionally, a previewed new anchor (Move anchor): the view centres on it,
 *   so the boat is seen against the circle it would have, and the anchor as
 *   it stands now is drawn faint
 *
 * Extracted from AnchorWatchPage.tsx for modularity.
 */

import React, { useRef, useEffect } from 'react';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';

export interface AisTargetDot {
    mmsi: number;
    name: string;
    lat: number;
    lon: number;
    /** Course over ground (°), or null when the vessel has not sent one. */
    cog: number | null;
    /** Speed over ground (kn), or null when the vessel has not sent one. */
    sog: number | null;
    statusColor: string;
}

type LatLon = { latitude: number; longitude: number };

/**
 * East (dx) and north (dy) metres of `point` from `anchor`, on the flat local
 * plane the radar draws. The longitude difference is wrapped into ±180°: an
 * anchor at 179.9999°E with the boat at 179.9999°W is a few metres apart, not
 * a whole world (it was drawn 40 000 km off screen before, in Fiji or anywhere
 * else on the antimeridian).
 */
export function offsetFromAnchorM(anchor: LatLon, point: LatLon): { dx: number; dy: number } {
    const dLon = ((((point.longitude - anchor.longitude) % 360) + 540) % 360) - 180;
    return {
        dx: dLon * 111320 * Math.cos((anchor.latitude * Math.PI) / 180),
        dy: (point.latitude - anchor.latitude) * 110540,
    };
}

/**
 * What the radar reads, and nothing more (126-03a). A whole AnchorWatchSnapshot
 * is one (the boat's own watch passes its snapshot); Shore Watch builds one
 * from the broadcast it hears and her trail, with no invented fields: a
 * half-minute mean has no heading, and a Pi's anchor no time.
 */
export type SwingCanvasModel = Pick<AnchorWatchSnapshot, 'state' | 'swingRadius' | 'gpsAccuracy'> & {
    anchorPosition: LatLon | null;
    vesselPosition: LatLon | null;
    /** Her trail, oldest first. */
    positionHistory: readonly LatLon[];
};

/**
 * The compass rose on a `width` x `height` canvas: the swing circle's radius
 * on screen, how far past it the ticks start (major, minor, other) and end,
 * and where N, E, S and W sit.
 *
 * As drawn on the boat's own radar: the circle at 35% of the short side, the
 * ticks to 22 px past it, the letters 32 px past it. That needs a short side
 * of about 267 px; on less, the letters fall off the canvas. With `fit`
 * (Shore Watch's radar, 128-256 px), a smaller canvas gets a tighter rose and
 * a circle pulled in just enough to keep each letter's centre 8 px inside.
 */
export function radarRose(width: number, height: number, fit = false) {
    const short = Math.min(width, height);
    const radius = short * 0.35;
    if (!fit || short / 2 - radius >= 40) {
        return { displayRadius: radius, tickFrom: { major: 12, minor: 16, other: 18 }, tickTo: 22, labelAt: 32 };
    }
    return {
        displayRadius: Math.max(0, Math.min(radius, short / 2 - 26)),
        tickFrom: { major: 2, minor: 5, other: 7 },
        tickTo: 10,
        labelAt: 18,
    };
}

interface SwingCircleCanvasProps {
    model?: SwingCanvasModel | null;
    /** The same as `model`, under the name the boat's own callers use. */
    snapshot?: SwingCanvasModel | null;
    aisTargets?: AisTargetDot[];
    className?: string;
    ariaLabel?: string;
    /** A proposed new anchor: drawn at the centre with the swing circle around it. */
    previewAnchor?: LatLon | null;
    /** Keep N, E, S and W on a small canvas (radarRose's `fit`). */
    fitRose?: boolean;
}

export const SwingCircleCanvas: React.FC<SwingCircleCanvasProps> = ({
    model,
    snapshot: snapshotAlias,
    aisTargets,
    className,
    ariaLabel,
    previewAnchor,
    fitRose = false,
}) => {
    const snapshot = model ?? snapshotAlias ?? null;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const previewLat = previewAnchor?.latitude;
    const previewLon = previewAnchor?.longitude;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !snapshot?.anchorPosition) return;
        const anchorNow = snapshot.anchorPosition;
        const previewing = Number.isFinite(previewLat) && Number.isFinite(previewLon);
        // Everything is drawn relative to the centre: the anchor as it stands,
        // or the previewed one.
        const centre: LatLon = previewing ? { latitude: previewLat!, longitude: previewLon! } : anchorNow;

        let rafId: number;

        const draw = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();

            // Skip if not yet laid out
            if (rect.width === 0 || rect.height === 0) {
                rafId = requestAnimationFrame(draw);
                return;
            }

            // Resize backing buffer to match CSS size × DPR
            const wPx = Math.round(rect.width * dpr);
            const hPx = Math.round(rect.height * dpr);
            if (canvas.width !== wPx || canvas.height !== hPx) {
                canvas.width = wPx;
                canvas.height = hPx;
            }

            // Work in CSS-pixel space
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const W = rect.width;
            const H = rect.height;
            const cx = W / 2;
            const cy = H / 2;
            const isAlarm = snapshot.state === 'alarm';
            const daylight = canvas.closest('.display-light') !== null;

            // Clear
            ctx.clearRect(0, 0, W, H);

            // Scale: fit swing radius + margin into canvas (always use min dimension for perfect circle)
            const rose = radarRose(W, H, fitRose);
            const displayRadius = rose.displayRadius;
            const scale = snapshot.swingRadius > 0 ? displayRadius / snapshot.swingRadius : 1;

            // ── Ocean depth background gradient ──
            const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
            bgGrad.addColorStop(0, daylight ? '#ffffff' : 'rgba(8, 47, 73, 0.4)');
            bgGrad.addColorStop(0.5, daylight ? '#f1f5f9' : 'rgba(7, 33, 54, 0.25)');
            bgGrad.addColorStop(1, daylight ? '#e2e8f0' : 'rgba(2, 6, 23, 0.1)');
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, W, H);

            // ── Compass rose tick marks ──
            const numTicks = 36;
            for (let i = 0; i < numTicks; i++) {
                const angle = (((i * 360) / numTicks - 90) * Math.PI) / 180;
                const isMajor = i % 9 === 0;
                const isMinor = i % 3 === 0;
                const innerR =
                    displayRadius +
                    (isMajor ? rose.tickFrom.major : isMinor ? rose.tickFrom.minor : rose.tickFrom.other);
                const outerR = displayRadius + rose.tickTo;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
                ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
                ctx.strokeStyle = daylight
                    ? isMajor
                        ? '#475569'
                        : 'rgba(71, 85, 105, 0.4)'
                    : isMajor
                      ? 'rgba(148, 163, 184, 0.5)'
                      : 'rgba(100, 116, 139, 0.2)';
                ctx.lineWidth = isMajor ? 1.5 : 0.5;
                ctx.stroke();
            }

            // ── Compass cardinal labels ──
            const labelOffset = displayRadius + rose.labelAt;
            ctx.font = 'bold 13px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const cardinals = [
                { label: 'N', angle: -90, color: daylight ? '#b91c1c' : '#f87171' },
                { label: 'E', angle: 0, color: daylight ? '#475569' : '#cbd5e1' },
                { label: 'S', angle: 90, color: daylight ? '#475569' : '#cbd5e1' },
                { label: 'W', angle: 180, color: daylight ? '#475569' : '#cbd5e1' },
            ];
            cardinals.forEach(({ label, angle, color }) => {
                const rad = (angle * Math.PI) / 180;
                ctx.fillStyle = color;
                ctx.fillText(label, cx + Math.cos(rad) * labelOffset, cy + Math.sin(rad) * labelOffset);
            });

            // ── Color-coded zone bands ──
            // Green safe zone: 0 → 85% of swing radius
            const safeZoneGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, displayRadius * 0.85);
            safeZoneGrad.addColorStop(0, isAlarm ? 'rgba(239, 68, 68, 0.03)' : 'rgba(34, 197, 94, 0.06)');
            safeZoneGrad.addColorStop(0.7, isAlarm ? 'rgba(239, 68, 68, 0.04)' : 'rgba(34, 197, 94, 0.08)');
            safeZoneGrad.addColorStop(1, isAlarm ? 'rgba(239, 68, 68, 0.06)' : 'rgba(34, 197, 94, 0.12)');
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2);
            ctx.fillStyle = safeZoneGrad;
            ctx.fill();

            // Green safe zone border ring at 85%
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2);
            ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.12)' : 'rgba(34, 197, 94, 0.2)';
            ctx.lineWidth = 0.5;
            ctx.stroke();

            // Amber caution band: 85% → 100% of swing radius
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2);
            ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2, true); // cut out inner
            ctx.fillStyle = isAlarm ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.07)';
            ctx.fill();

            // Red alarm halo: 100% → 120% (danger zone beyond boundary)
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius * 1.2, 0, Math.PI * 2);
            ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2, true);
            ctx.fillStyle = isAlarm ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.03)';
            ctx.fill();

            // Swing radius boundary ring (solid, prominent)
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2);
            ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.4)';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Subtle 50% reference ring (no label)
            ctx.beginPath();
            ctx.arc(cx, cy, displayRadius * 0.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(71, 85, 105, 0.12)';
            ctx.lineWidth = 0.5;
            ctx.setLineDash([2, 4]);
            ctx.stroke();
            ctx.setLineDash([]);

            // ── Anchor icon at center ──
            ctx.font = '18px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
            ctx.fillText('⚓', cx, cy);

            // ── Previewing a move: where the anchor stands now, faint, joined to the new one ──
            if (previewing) {
                const now = offsetFromAnchorM(centre, anchorNow);
                const ox = cx + now.dx * scale;
                const oy = cy - now.dy * scale;
                ctx.beginPath();
                ctx.moveTo(ox, oy);
                ctx.lineTo(cx, cy);
                ctx.strokeStyle = daylight ? 'rgba(180, 83, 9, 0.55)' : 'rgba(251, 191, 36, 0.45)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 0.4;
                ctx.fillText('⚓', ox, oy);
                ctx.globalAlpha = 1;
            }

            // ── Position history trail — gradient heat map ──
            if (snapshot.positionHistory.length > 1) {
                const histLen = snapshot.positionHistory.length;
                for (let i = 1; i < histLen; i++) {
                    const { dx: pDx, dy: pDy } = offsetFromAnchorM(centre, snapshot.positionHistory[i - 1]);
                    const { dx: cDx, dy: cDy } = offsetFromAnchorM(centre, snapshot.positionHistory[i]);

                    const t = i / histLen; // 0=old, 1=new
                    const alpha = 0.15 + t * 0.55;

                    ctx.beginPath();
                    ctx.moveTo(cx + pDx * scale, cy - pDy * scale);
                    ctx.lineTo(cx + cDx * scale, cy - cDy * scale);

                    // Green→Sky→Red heat map based on recency
                    const r = Math.round(56 + t * 183);
                    const g = Math.round(189 - t * 121);
                    const b = Math.round(248 - t * 200);
                    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
                    ctx.lineWidth = 1 + t * 1.5;
                    ctx.stroke();
                }
            }

            // ── Vessel position with glowing marker ──
            if (snapshot.vesselPosition) {
                const { dx, dy } = offsetFromAnchorM(centre, snapshot.vesselPosition);
                const vx = cx + dx * scale;
                const vy = cy - dy * scale;

                // Outer glow pulse
                const pulseSize = 18 + Math.sin(Date.now() / 400) * 4;
                const outerGlow = ctx.createRadialGradient(vx, vy, 0, vx, vy, pulseSize);
                if (isAlarm) {
                    outerGlow.addColorStop(0, 'rgba(239, 68, 68, 0.3)');
                    outerGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
                } else {
                    outerGlow.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
                    outerGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
                }
                ctx.beginPath();
                ctx.arc(vx, vy, pulseSize, 0, Math.PI * 2);
                ctx.fillStyle = outerGlow;
                ctx.fill();

                // Inner ring
                ctx.beginPath();
                ctx.arc(vx, vy, 8, 0, Math.PI * 2);
                ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.6)' : 'rgba(56, 189, 248, 0.5)';
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Core dot
                ctx.beginPath();
                ctx.arc(vx, vy, 4, 0, Math.PI * 2);
                const coreGrad = ctx.createRadialGradient(vx, vy, 0, vx, vy, 4);
                coreGrad.addColorStop(0, isAlarm ? '#fca5a5' : '#7dd3fc');
                coreGrad.addColorStop(1, isAlarm ? '#ef4444' : '#38bdf8');
                ctx.fillStyle = coreGrad;
                ctx.fill();

                // GPS accuracy circle
                if (snapshot.gpsAccuracy > 0) {
                    const accRadius = snapshot.gpsAccuracy * scale;
                    ctx.beginPath();
                    ctx.arc(vx, vy, accRadius, 0, Math.PI * 2);
                    ctx.strokeStyle = daylight ? 'rgba(71, 85, 105, 0.45)' : 'rgba(148, 163, 184, 0.12)';
                    ctx.lineWidth = 0.5;
                    ctx.setLineDash([2, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // ── AIS targets ──
            if (aisTargets && aisTargets.length > 0) {
                // Max visible radius in meters
                const maxVisibleM = snapshot.swingRadius * 1.3;

                for (const target of aisTargets) {
                    // Offset from anchor in meters
                    const { dx: tdx, dy: tdy } = offsetFromAnchorM(centre, {
                        latitude: target.lat,
                        longitude: target.lon,
                    });

                    // Skip if too far from anchor to be visible
                    const distM = Math.sqrt(tdx * tdx + tdy * tdy);
                    if (distM > maxVisibleM * 2) continue;

                    const tx = cx + tdx * scale;
                    const ty = cy - tdy * scale;

                    // Skip if off canvas
                    if (tx < -10 || tx > W + 10 || ty < -10 || ty > H + 10) continue;

                    const color = target.statusColor || '#38bdf8';

                    // Subtle glow
                    const tGlow = ctx.createRadialGradient(tx, ty, 0, tx, ty, 8);
                    tGlow.addColorStop(0, color.replace(')', ', 0.2)').replace('rgb(', 'rgba('));
                    tGlow.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.beginPath();
                    ctx.arc(tx, ty, 8, 0, Math.PI * 2);
                    ctx.fillStyle = tGlow;
                    ctx.fill();

                    if (target.cog === null) {
                        // Heading unknown: a plain dot, never a triangle pointing an invented way.
                        ctx.beginPath();
                        ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
                        ctx.fillStyle = color;
                        ctx.fill();
                        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                        ctx.lineWidth = 0.5;
                        ctx.stroke();
                        continue;
                    }

                    // Rotated triangle (boat shape)
                    const cogRad = ((target.cog - 90) * Math.PI) / 180;
                    const size = 5;
                    ctx.save();
                    ctx.translate(tx, ty);
                    ctx.rotate(cogRad);
                    ctx.beginPath();
                    ctx.moveTo(size, 0); // nose
                    ctx.lineTo(-size * 0.6, -size * 0.5); // port stern
                    ctx.lineTo(-size * 0.6, size * 0.5); // starboard stern
                    ctx.closePath();
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                    ctx.restore();
                }

                // AIS count badge
                const visibleCount = aisTargets.length;
                if (visibleCount > 0) {
                    const badgeX = W - 8;
                    const badgeY = 14;
                    ctx.font = 'bold 12px system-ui';
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = daylight ? '#0369a1' : '#7dd3fc';
                    ctx.fillText(`🚢 ${visibleCount}`, badgeX, badgeY);
                }
            }

            // Continue animation loop
            rafId = requestAnimationFrame(draw);
        };

        // Start animation loop
        rafId = requestAnimationFrame(draw);

        // Watch for container resize (handles tab switching, orientation changes)
        const observer = new ResizeObserver(() => {
            // Canvas will pick up new size on next draw frame
        });
        observer.observe(canvas);

        return () => {
            cancelAnimationFrame(rafId);
            observer.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot, previewLat, previewLon, fitRose]);

    return (
        <canvas
            ref={canvasRef}
            className={className || 'w-full h-full'}
            style={{ touchAction: 'none' }}
            role="img"
            aria-label={ariaLabel}
        />
    );
};
