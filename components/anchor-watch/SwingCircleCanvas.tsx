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
    cog: number;
    sog: number;
    statusColor: string;
}

interface SwingCircleCanvasProps {
    snapshot: AnchorWatchSnapshot | null;
    aisTargets?: AisTargetDot[];
    className?: string;
    ariaLabel?: string;
}

export const SwingCircleCanvas: React.FC<SwingCircleCanvasProps> = ({ snapshot, aisTargets, className, ariaLabel }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !snapshot?.anchorPosition) return;

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

            // Clear
            ctx.clearRect(0, 0, W, H);

            // Scale: fit swing radius + margin into canvas (always use min dimension for perfect circle)
            const displayRadius = Math.min(W, H) * 0.35;
            const scale = snapshot.swingRadius > 0 ? displayRadius / snapshot.swingRadius : 1;

            // ── Ocean depth background gradient ──
            const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
            bgGrad.addColorStop(0, 'rgba(8, 47, 73, 0.4)');
            bgGrad.addColorStop(0.5, 'rgba(7, 33, 54, 0.25)');
            bgGrad.addColorStop(1, 'rgba(2, 6, 23, 0.1)');
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, W, H);

            // ── Compass rose tick marks ──
            const numTicks = 36;
            for (let i = 0; i < numTicks; i++) {
                const angle = (((i * 360) / numTicks - 90) * Math.PI) / 180;
                const isMajor = i % 9 === 0;
                const isMinor = i % 3 === 0;
                const innerR = displayRadius + (isMajor ? 12 : isMinor ? 16 : 18);
                const outerR = displayRadius + 22;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
                ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
                ctx.strokeStyle = isMajor ? 'rgba(148, 163, 184, 0.5)' : 'rgba(100, 116, 139, 0.2)';
                ctx.lineWidth = isMajor ? 1.5 : 0.5;
                ctx.stroke();
            }

            // ── Compass cardinal labels ──
            const labelOffset = displayRadius + 32;
            ctx.font = 'bold 13px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const cardinals = [
                { label: 'N', angle: -90, color: 'rgba(248, 113, 113, 0.8)' },
                { label: 'E', angle: 0, color: 'rgba(148, 163, 184, 0.5)' },
                { label: 'S', angle: 90, color: 'rgba(148, 163, 184, 0.5)' },
                { label: 'W', angle: 180, color: 'rgba(148, 163, 184, 0.5)' },
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

            // ── Position history trail — gradient heat map ──
            if (snapshot.positionHistory.length > 1 && snapshot.anchorPosition) {
                const histLen = snapshot.positionHistory.length;
                for (let i = 1; i < histLen; i++) {
                    const prev = snapshot.positionHistory[i - 1];
                    const curr = snapshot.positionHistory[i];
                    const pDx =
                        (prev.longitude - snapshot.anchorPosition!.longitude) *
                        111320 *
                        Math.cos((snapshot.anchorPosition!.latitude * Math.PI) / 180);
                    const pDy = (prev.latitude - snapshot.anchorPosition!.latitude) * 110540;
                    const cDx =
                        (curr.longitude - snapshot.anchorPosition!.longitude) *
                        111320 *
                        Math.cos((snapshot.anchorPosition!.latitude * Math.PI) / 180);
                    const cDy = (curr.latitude - snapshot.anchorPosition!.latitude) * 110540;

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
            if (snapshot.vesselPosition && snapshot.anchorPosition) {
                const dx =
                    (snapshot.vesselPosition.longitude - snapshot.anchorPosition.longitude) *
                    111320 *
                    Math.cos((snapshot.anchorPosition.latitude * Math.PI) / 180);
                const dy = (snapshot.vesselPosition.latitude - snapshot.anchorPosition.latitude) * 110540;
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
                    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
                    ctx.lineWidth = 0.5;
                    ctx.setLineDash([2, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // ── AIS targets ──
            if (aisTargets && aisTargets.length > 0 && snapshot.anchorPosition) {
                const ancLat = snapshot.anchorPosition.latitude;
                const ancLon = snapshot.anchorPosition.longitude;
                const cosAncLat = Math.cos((ancLat * Math.PI) / 180);
                // Max visible radius in meters
                const maxVisibleM = snapshot.swingRadius * 1.3;

                for (const target of aisTargets) {
                    // Offset from anchor in meters
                    const tdx = (target.lon - ancLon) * 111320 * cosAncLat;
                    const tdy = (target.lat - ancLat) * 110540;

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

                    // Rotated triangle (boat shape)
                    const cogRad = ((target.cog - 90) * Math.PI) / 180;
                    const size = 5;
                    ctx.save();
                    ctx.translate(tx, ty);
                    ctx.rotate(cogRad);
                    ctx.beginPath();
                    ctx.moveTo(size, 0);         // nose
                    ctx.lineTo(-size * 0.6, -size * 0.5); // port stern
                    ctx.lineTo(-size * 0.6, size * 0.5);  // starboard stern
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
                    ctx.font = 'bold 9px system-ui';
                    ctx.textAlign = 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = 'rgba(56, 189, 248, 0.5)';
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
    }, [snapshot]);

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
