/**
 * RouteTrackPicker — modal sheet listing the user's saved routes or
 * recorded tracks. Used twice in MapHub:
 *
 *   variant="route"  — green dashed lines, "Routes" picker
 *                      Source: ship_log entries with voyageId starting `planned_*`
 *
 *   variant="track"  — amber solid lines, "Tracks" picker
 *                      Source: ship_log entries grouped by voyageId
 *
 * Picks one item → caller sets it as the active selection on its
 * matching useRouteTrackLayer hook → map renders + fits bounds.
 *
 * The sheet has a "None / clear" footer so the user can dismiss the
 * active selection without juggling the radial menu toggle.
 *
 * Visuals match the rest of the chart-screen chip family — slate
 * translucent, blur, 16px radius, soft border.
 */
import React, { useEffect, useState, useRef } from 'react';
import { fetchRoutesAndTracks, type RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
import { triggerHaptic } from '../../utils/system';
import { useDeviceClass, pickByDevice } from '../../utils/useDeviceClass';

export type RouteTrackVariant = 'route' | 'track';

interface RouteTrackPickerProps {
    visible: boolean;
    variant: RouteTrackVariant;
    /** Currently-selected id (highlighted with a checkmark). */
    selectedId: string | null;
    onSelect: (item: RouteOrTrack | null) => void;
    onClose: () => void;
}

const VARIANT_META: Record<RouteTrackVariant, { title: string; emptyMsg: string; accent: string }> = {
    route: {
        title: 'Routes',
        emptyMsg: 'No saved routes yet. Plan a passage in the Voyage page and tap Save to add it here.',
        // Matches useRouteTrackLayer's violet — saved-plan colour kept
        // semantically separate from the sky-blue active follow-route.
        accent: '#a855f7',
    },
    track: {
        title: 'Tracks',
        emptyMsg:
            'No recorded tracks yet. Active voyage GPS positions will appear here as a track once you start sailing.',
        accent: '#fbbf24',
    },
};

export const RouteTrackPicker: React.FC<RouteTrackPickerProps> = ({
    visible,
    variant,
    selectedId,
    onSelect,
    onClose,
}) => {
    const [items, setItems] = useState<RouteOrTrack[] | null>(null);
    const [loading, setLoading] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const meta = VARIANT_META[variant];
    const deviceClass = useDeviceClass();
    const sheetMinWidth = pickByDevice(deviceClass, 280, 420);
    const sheetMaxWidth = pickByDevice(deviceClass, 360, 520);
    const titleFontSize = pickByDevice(deviceClass, 12, 14);
    const labelFontSize = pickByDevice(deviceClass, 12, 14);
    const sublabelFontSize = pickByDevice(deviceClass, 10, 12);

    // Load when opened. Cached at the service layer (60s) so re-opening
    // fast is essentially free.
    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        setLoading(true);
        fetchRoutesAndTracks()
            .then((res) => {
                if (cancelled) return;
                setItems(variant === 'route' ? res.routes : res.tracks);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, variant]);

    // Outside-tap close.
    useEffect(() => {
        if (!visible) return;
        const onDoc = (e: Event) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('touchstart', onDoc);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('touchstart', onDoc);
        };
    }, [visible, onClose]);

    if (!visible) return null;

    return (
        <div
            ref={wrapRef}
            className="fixed left-1/2 -translate-x-1/2 z-[185] pointer-events-auto chart-chip-in"
            style={{ top: 'max(56px, calc(env(safe-area-inset-top) + 56px))' }}
            role="dialog"
            aria-label={`${meta.title} picker`}
        >
            <div
                className="flex flex-col"
                style={{
                    background: 'rgba(15, 23, 42, 0.94)',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 16,
                    boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                    minWidth: sheetMinWidth,
                    maxWidth: `min(${sheetMaxWidth}px, calc(100vw - 24px))`,
                    maxHeight: 'min(560px, calc(100vh - 140px))',
                }}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between"
                    style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
                >
                    <span className="flex items-center gap-2">
                        <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: meta.accent }}
                            aria-hidden
                        />
                        <span
                            className="font-semibold tracking-wide"
                            style={{ color: 'rgba(255,255,255,0.92)', fontSize: titleFontSize }}
                        >
                            {meta.title}
                        </span>
                    </span>
                    <button
                        onClick={onClose}
                        aria-label="Close picker"
                        className="opacity-60 hover:opacity-100"
                        style={{ color: '#fff', fontSize: 16, lineHeight: 1, padding: '0 4px' }}
                    >
                        ×
                    </button>
                </div>

                {/* Body */}
                <div style={{ overflowY: 'auto', padding: '4px 6px' }}>
                    {loading && (
                        <div className="text-[11px] opacity-70" style={{ padding: '14px 8px', color: '#94a3b8' }}>
                            Loading…
                        </div>
                    )}
                    {!loading && items && items.length === 0 && (
                        <div
                            className="text-[11px] leading-snug"
                            style={{ padding: '14px 10px', color: 'rgba(255,255,255,0.7)' }}
                        >
                            {meta.emptyMsg}
                        </div>
                    )}
                    {!loading &&
                        items &&
                        items.map((item) => {
                            const active = selectedId === item.id;
                            return (
                                <button
                                    key={item.id}
                                    onClick={() => {
                                        triggerHaptic('light');
                                        onSelect(item);
                                        onClose();
                                    }}
                                    className="w-full flex items-center gap-3 text-left transition-colors"
                                    style={{
                                        background: active ? `${meta.accent}22` : 'transparent',
                                        borderRadius: 10,
                                        padding: '8px 10px',
                                        border: active ? `1px solid ${meta.accent}55` : '1px solid transparent',
                                        marginBottom: 2,
                                    }}
                                >
                                    <span className="flex-1 min-w-0" style={{ color: 'rgba(255,255,255,0.9)' }}>
                                        <span
                                            className="block font-semibold truncate"
                                            style={{
                                                fontSize: labelFontSize,
                                                color: active ? meta.accent : 'inherit',
                                            }}
                                        >
                                            {item.label}
                                        </span>
                                        <span
                                            className="block opacity-70 truncate"
                                            style={{ fontSize: sublabelFontSize, marginTop: 1 }}
                                        >
                                            {item.sublabel}
                                        </span>
                                    </span>
                                    {active && (
                                        <span aria-hidden style={{ color: meta.accent, fontWeight: 700 }}>
                                            ✓
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                </div>

                {/* Footer — Clear button when something is selected */}
                {selectedId && (
                    <div
                        style={{
                            padding: '6px 8px',
                            borderTop: '1px solid rgba(255,255,255,0.06)',
                        }}
                    >
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                onSelect(null);
                                onClose();
                            }}
                            className="w-full text-center text-[11px] font-semibold opacity-80 hover:opacity-100"
                            style={{
                                color: 'rgba(255,255,255,0.7)',
                                padding: '6px',
                                borderRadius: 8,
                                background: 'transparent',
                                border: '1px solid rgba(255,255,255,0.08)',
                            }}
                        >
                            Clear selection
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
