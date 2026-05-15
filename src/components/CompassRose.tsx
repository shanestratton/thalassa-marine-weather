import React from 'react';

/**
 * Decorative marine-chart compass rose for a corner of the map. Pure
 * SVG, static (the map isn't rotated, so the rose isn't either). Plays
 * the role of the rose on a paper chart — a signal that this is a nav
 * view, not just a map.
 */
export const CompassRose: React.FC = () => {
    // Geometry: viewBox 100×100, centred on (50,50). Radii shrunk so the
    // N/E/S/W labels sit comfortably inside the viewBox at fontSize 9 —
    // SVGs clip at the viewBox boundary by default, so anything past 50
    // from centre gets eaten.
    const cx = 50;
    const cy = 50;
    const outer = 36; // outer ring radius
    const inner = 11; // inner ring radius
    const spokeOut = 33; // long spoke tip
    const spokeOutShort = 21; // intercardinal spoke tip
    const labelR = 43; // cardinal label radius (outside the rose, inside the viewBox)

    // Cardinal spokes are alternating-fill triangles (a "wind rose" star).
    // For each cardinal angle a, draw a long triangle pointing outward.
    // The pair on either side of N gets the bold/contrast fill.
    const cardinal = [
        { angle: 0, label: 'N', isN: true },
        { angle: 90, label: 'E' },
        { angle: 180, label: 'S' },
        { angle: 270, label: 'W' },
    ];
    const intercardinal = [45, 135, 225, 315];

    const polar = (a: number, r: number): [number, number] => {
        const rad = ((a - 90) * Math.PI) / 180;
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };

    return (
        <div
            aria-hidden="true"
            className="pointer-events-none w-[88px] h-[88px] rounded-full bg-slate-900/50 backdrop-blur-md border border-white/10 shadow-lg p-1.5"
        >
            <svg viewBox="0 0 100 100" className="w-full h-full">
                {/* Outer ring */}
                <circle cx={cx} cy={cy} r={outer} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                {/* Inner ring */}
                <circle cx={cx} cy={cy} r={inner} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={0.8} />

                {/* Minor degree ticks every 10° */}
                {Array.from({ length: 36 }).map((_, i) => {
                    const a = i * 10;
                    const isMajor = a % 90 === 0;
                    const isHalf = a % 30 === 0;
                    const [x1, y1] = polar(a, outer - (isMajor ? 6 : isHalf ? 4 : 2));
                    const [x2, y2] = polar(a, outer);
                    return (
                        <line
                            key={i}
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={isMajor ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'}
                            strokeWidth={isMajor ? 1.2 : 0.6}
                            strokeLinecap="round"
                        />
                    );
                })}

                {/* Intercardinal short spokes — light grey diamond tips */}
                {intercardinal.map((a) => {
                    const [tx, ty] = polar(a, spokeOutShort);
                    const [lx, ly] = polar(a - 90, 4);
                    const [rx, ry] = polar(a + 90, 4);
                    return (
                        <polygon
                            key={a}
                            points={`${tx},${ty} ${cx + lx - cx},${cy + ly - cy} ${cx + rx - cx},${cy + ry - cy}`}
                            fill="rgba(255,255,255,0.18)"
                        />
                    );
                })}

                {/* Cardinal long spokes — alternating light/dark for the classic star look */}
                {cardinal.map(({ angle }, i) => {
                    const [tx, ty] = polar(angle, spokeOut);
                    // Left-side triangle (darker)
                    const [lx, ly] = polar(angle - 90, 5);
                    // Right-side triangle (lighter)
                    const [rx, ry] = polar(angle + 90, 5);
                    return (
                        <g key={angle}>
                            {/* Dark half (left of axis) */}
                            <polygon
                                points={`${tx},${ty} ${cx},${cy} ${cx + (lx - cx)},${cy + (ly - cy)}`}
                                fill="rgba(15,23,42,0.85)"
                                stroke="rgba(255,255,255,0.45)"
                                strokeWidth={0.5}
                            />
                            {/* Light half (right of axis) */}
                            <polygon
                                points={`${tx},${ty} ${cx},${cy} ${cx + (rx - cx)},${cy + (ry - cy)}`}
                                fill={i === 0 ? '#f87171' : 'rgba(255,255,255,0.85)'}
                                stroke="rgba(255,255,255,0.45)"
                                strokeWidth={0.5}
                            />
                        </g>
                    );
                })}

                {/* Cardinal labels */}
                {cardinal.map(({ angle, label, isN }) => {
                    const [tx, ty] = polar(angle, labelR);
                    return (
                        <text
                            key={angle}
                            x={tx}
                            y={ty}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fontSize="9"
                            fontWeight="800"
                            fontFamily="system-ui, -apple-system, sans-serif"
                            fill={isN ? '#fca5a5' : 'rgba(226,232,240,0.85)'}
                            style={{ letterSpacing: '0.05em' }}
                        >
                            {label}
                        </text>
                    );
                })}

                {/* Centre hub */}
                <circle
                    cx={cx}
                    cy={cy}
                    r="2.2"
                    fill="rgba(15,23,42,0.95)"
                    stroke="rgba(255,255,255,0.4)"
                    strokeWidth={0.6}
                />
            </svg>
        </div>
    );
};
