/**
 * TideCanvas — Canvas-based tide chart renderer.
 *
 * Replaces old Recharts SVG approach with a single <canvas> draw call.
 * Canvas eliminates SVG DOM overhead and merges what were two stacked
 * AreaCharts into one performant draw call.
 *
 * Features:
 * - Vertical grid lines every 2 hours, labels every 4 hours
 * - Neon gradient stroke (cyan at peaks → orange at troughs)
 * - Smooth area fill under the curve
 * - Current-time hairline + glow dot
 */
import React, { useEffect, useRef, useCallback } from 'react';

interface TideCanvasProps {
    dataPoints: { time: number; height: number }[];
    currentHour: number;
    currentHeight: number;
    minHeight: number;
    maxHeight: number;
    domainBuffer: number;
}

export const TideCanvas = React.memo(
    ({ dataPoints, currentHour, currentHeight, minHeight, maxHeight, domainBuffer }: TideCanvasProps) => {
        const canvasRef = useRef<HTMLCanvasElement>(null);
        const containerRef = useRef<HTMLDivElement>(null);

        const draw = useCallback(() => {
            const canvas = canvasRef.current;
            const container = containerRef.current;
            if (!canvas || !container || dataPoints.length < 2) return;

            const dpr = window.devicePixelRatio || 1;
            const rect = container.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;

            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;

            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.scale(dpr, dpr);

            // Chart area with margins matching old Recharts layout
            const marginTop = 20;
            const marginRight = 0;
            const marginLeft = 0;
            const marginBottom = 4;
            const plotW = w - marginLeft - marginRight;
            const plotH = h - marginTop - marginBottom;

            const yMin = minHeight - domainBuffer;
            const yMax = maxHeight + domainBuffer;

            // Coordinate mappers
            const toX = (time: number) => marginLeft + (time / 24) * plotW;
            const toY = (height: number) => marginTop + plotH - ((height - yMin) / (yMax - yMin)) * plotH;

            // Clear
            ctx.clearRect(0, 0, w, h);

            // --- VERTICAL GRID LINES (every 2 hours) ---
            for (let hour = 0; hour <= 24; hour += 2) {
                const gx = toX(hour);
                ctx.save();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(gx, marginTop);
                ctx.lineTo(gx, h - marginBottom);
                ctx.stroke();

                // Label every 4 hours
                if (hour % 4 === 0 && hour < 24) {
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
                    ctx.font = '8px system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(hour.toString().padStart(2, '0'), gx, h - 1);
                }
                ctx.restore();
            }

            // --- Height-to-color helper (neon gradient: cyan at high, orange at low) ---
            const getHeightColor = (height: number): { r: number; g: number; b: number } => {
                const t = (height - yMin) / (yMax - yMin); // 0 = bottom, 1 = top
                return {
                    r: Math.round(251 + (34 - 251) * t),
                    g: Math.round(146 + (211 - 146) * t),
                    b: Math.round(60 + (238 - 60) * t),
                };
            };

            // --- FILL: Professional area shading under the curve ---
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(toX(dataPoints[0].time), toY(dataPoints[0].height));
            for (let i = 1; i < dataPoints.length; i++) {
                ctx.lineTo(toX(dataPoints[i].time), toY(dataPoints[i].height));
            }
            ctx.lineTo(toX(dataPoints[dataPoints.length - 1].time), h);
            ctx.lineTo(toX(dataPoints[0].time), h);
            ctx.closePath();

            const fillGrad = ctx.createLinearGradient(0, marginTop, 0, h);
            fillGrad.addColorStop(0, 'rgba(34, 211, 238, 0.35)');
            fillGrad.addColorStop(0.3, 'rgba(20, 184, 166, 0.25)');
            fillGrad.addColorStop(0.6, 'rgba(20, 184, 166, 0.14)');
            fillGrad.addColorStop(1, 'rgba(20, 184, 166, 0.03)');
            ctx.fillStyle = fillGrad;
            ctx.fill();
            ctx.restore();

            // --- NEON STROKE (Two-pass for performance) ---

            // Pass 1: Single glow underlay
            ctx.save();
            ctx.shadowColor = 'rgba(34, 211, 238, 0.4)';
            ctx.shadowBlur = 12;
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
            ctx.beginPath();
            ctx.moveTo(toX(dataPoints[0].time), toY(dataPoints[0].height));
            for (let i = 1; i < dataPoints.length; i++) {
                ctx.lineTo(toX(dataPoints[i].time), toY(dataPoints[i].height));
            }
            ctx.stroke();
            ctx.restore();

            // Pass 2: Per-segment colored stroke (NO shadow — fast)
            ctx.save();
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            for (let i = 1; i < dataPoints.length; i++) {
                const p0 = dataPoints[i - 1];
                const p1 = dataPoints[i];
                const midHeight = (p0.height + p1.height) / 2;

                const c = getHeightColor(midHeight);
                const segColor = `rgb(${c.r}, ${c.g}, ${c.b})`;

                ctx.beginPath();
                ctx.moveTo(toX(p0.time), toY(p0.height));
                ctx.lineTo(toX(p1.time), toY(p1.height));
                ctx.strokeStyle = segColor;
                ctx.stroke();
            }
            ctx.restore();

            // --- CURRENT TIME: Hairline vertical + Glow Dot ---
            if (currentHour >= 0 && currentHour <= 24) {
                const cx = toX(currentHour);
                const cy = toY(currentHeight);

                // Hairline vertical line (30% opacity)
                ctx.save();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(cx, marginTop);
                ctx.lineTo(cx, h - marginBottom);
                ctx.stroke();
                ctx.restore();

                // Dot color — match the curve color
                const dotC = getHeightColor(currentHeight);

                // Outer halo glow
                ctx.save();
                ctx.beginPath();
                ctx.arc(cx, cy, 10, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${dotC.r}, ${dotC.g}, ${dotC.b}, 0.2)`;
                ctx.fill();
                ctx.restore();

                // Mid ring
                ctx.beginPath();
                ctx.arc(cx, cy, 7, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${dotC.r}, ${dotC.g}, ${dotC.b}, 0.35)`;
                ctx.fill();

                // Solid white center (4px)
                ctx.beginPath();
                ctx.arc(cx, cy, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
            }
        }, [dataPoints, currentHour, currentHeight, minHeight, maxHeight, domainBuffer]);

        useEffect(() => {
            draw();
            const container = containerRef.current;
            if (!container) return;

            const ro = new ResizeObserver(() => draw());
            ro.observe(container);
            return () => ro.disconnect();
        }, [draw]);

        return (
            <div ref={containerRef} className="absolute inset-0">
                <canvas ref={canvasRef} className="absolute inset-0" />
            </div>
        );
    },
    (prev, next) => {
        return (
            prev.dataPoints === next.dataPoints &&
            prev.currentHour === next.currentHour &&
            prev.currentHeight === next.currentHeight &&
            prev.minHeight === next.minHeight &&
            prev.maxHeight === next.maxHeight
        );
    },
);
