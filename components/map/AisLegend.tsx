/**
 * AisLegend — Floating glass-pill legend showing AIS vessel status colours.
 *
 * Renders a compact, horizontally scrollable strip along the bottom
 * of the map. Only visible when AIS layers are active.
 */
import React from 'react';

const STATUS_ITEMS: { color: string; label: string }[] = [
    { color: '#22c55e', label: 'Underway' },
    { color: '#f59e0b', label: 'Anchored' },
    { color: '#94a3b8', label: 'Moored' },
    { color: '#06b6d4', label: 'Fishing' },
    { color: '#38bdf8', label: 'Class B' },
    { color: '#f97316', label: 'Restricted' },
    { color: '#ef4444', label: 'NUC / Aground' },
];

interface AisLegendProps {
    visible: boolean;
}

export const AisLegend: React.FC<AisLegendProps> = ({ visible }) => {
    if (!visible) return null;

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 28,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 400,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '6px 14px',
                background: 'rgba(15, 23, 42, 0.85)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 20,
                boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                animation: 'aisLegendIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
            }}
        >
            {STATUS_ITEMS.map(({ color, label }) => (
                <div
                    key={label}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                    }}
                >
                    <div
                        style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: color,
                            boxShadow: `0 0 5px ${color}80`,
                            flexShrink: 0,
                        }}
                    />
                    <span
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: '#94a3b8',
                            letterSpacing: 0.2,
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                        }}
                    >
                        {label}
                    </span>
                </div>
            ))}
        </div>
    );
};
