/**
 * RadialHelmMenu — Gesture-based two-tiered radial/arc menu for chart layer toggling.
 *
 * A single glassmorphic FAB sits on the right edge (thumb zone). Press-and-hold
 * expands Tier 1 (categories) in a tight arc. Drag to a category to expand Tier 2
 * (layer items). Release on an item to toggle the map layer. Quick-tap toggles the
 * layer menu open/closed without gestures.
 *
 * Designed for single-handed iPad/iPhone use on a pitching deck.
 * All animations use Framer Motion tight mechanical springs.
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { type WeatherLayer, SEA_STATE_LAYERS, ATMOSPHERE_LAYERS } from './mapConstants';
import { triggerHaptic } from '../../utils/system';

// ── Data structures ──────────────────────────────────────────────

export interface HelmMenuItem {
    id: string;
    label: string;
    icon: React.ReactNode;
    /** The WeatherLayer key this item toggles */
    layerKey?: WeatherLayer;
    /** For non-weather toggles (AIS, cyclones, etc.) */
    action?: () => void;
    /** If true, uses selectInGroup semantics (mutual exclusion) */
    groupExclusive?: boolean;
    /** The group array for selectInGroup */
    group?: WeatherLayer[];
}

export interface HelmCategory {
    id: string;
    label: string;
    icon: React.ReactNode;
    /** Accent color class (tailwind) */
    color: string;
    /** Glow color for active state */
    glowColor: string;
    items: HelmMenuItem[];
}

export interface RadialHelmMenuProps {
    activeLayers: Set<WeatherLayer>;
    toggleLayer: (layer: WeatherLayer) => void;
    selectInGroup: (layer: WeatherLayer, group: WeatherLayer[]) => void;
    /** Additional tactical toggles */
    tacticalState?: {
        aisVisible?: boolean;
        onToggleAis?: () => void;
        cycloneVisible?: boolean;
        onToggleCyclones?: () => void;
        squallVisible?: boolean;
        onToggleSquall?: () => void;
        lightningVisible?: boolean;
        onToggleLightning?: () => void;
        weatherInspectMode?: boolean;
        onToggleWeatherInspect?: () => void;
        seamarkVisible?: boolean;
        onToggleSeamark?: () => void;
        tideStationsVisible?: boolean;
        onToggleTideStations?: () => void;
        /** Marine Protected Areas (CAPAD vector overlay). */
        mpaVisible?: boolean;
        onToggleMpa?: () => void;
    };
    /** Nautical chart sources — populated by MapHub from the chart catalog +
     *  SignalK/AvNav + local MBTiles. Each entry renders as a toggle in the
     *  "Charts" category of the radial menu. Left empty → category hides. */
    chartsState?: {
        sources?: Array<{
            id: string;
            label: string;
            /** Short icon component — anchor for AvNav, flag for NOAA, etc. */
            iconKind: 'avnav' | 'noaa' | 'ecdis' | 'linz' | 'local' | 'generic';
            enabled: boolean;
            onToggle: () => void;
        }>;
    };
    /** If true, hide the menu entirely */
    hidden?: boolean;
}

// ── Arc math ─────────────────────────────────────────────────────

/** Convert polar (angle in degrees, radius in px) to cartesian offset from center */
function polarToXY(angleDeg: number, radius: number): { x: number; y: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return {
        x: Math.cos(rad) * radius,
        y: Math.sin(rad) * radius,
    };
}

/**
 * Distribute N items along an arc, centered on `centerAngle`.
 * Returns array of angles in degrees.
 */
function distributeArc(count: number, centerAngle: number, spread: number): number[] {
    if (count === 1) return [centerAngle];
    const step = spread / (count - 1);
    const start = centerAngle - spread / 2;
    return Array.from({ length: count }, (_, i) => start + step * i);
}

// ── Animation variants ──────────────────────────────────────────

const SPRING_TIGHT = { type: 'spring' as const, stiffness: 500, damping: 30, mass: 0.8 };
const SPRING_SNAPPY = { type: 'spring' as const, stiffness: 600, damping: 28, mass: 0.6 };

const fabVariants: Variants = {
    idle: { scale: 1, rotate: 0 },
    active: { scale: 1.05, rotate: 45, transition: SPRING_TIGHT },
};

const categoryVariants: Variants = {
    hidden: { scale: 0, opacity: 0 },
    visible: (i: number) => ({
        scale: 1,
        opacity: 1,
        transition: { ...SPRING_SNAPPY, delay: i * 0.04 },
    }),
    exit: (i: number) => ({
        scale: 0,
        opacity: 0,
        transition: { duration: 0.15, delay: i * 0.02 },
    }),
};

const itemVariants: Variants = {
    hidden: { scale: 0, opacity: 0 },
    visible: (i: number) => ({
        scale: 1,
        opacity: 1,
        transition: { ...SPRING_SNAPPY, delay: i * 0.03 },
    }),
    exit: {
        scale: 0,
        opacity: 0,
        transition: { duration: 0.12 },
    },
};

const glowPulse: Variants = {
    inactive: { boxShadow: '0 0 0px 0px rgba(56,189,248,0)' },
    active: {
        boxShadow: [
            '0 0 8px 2px rgba(56,189,248,0.3)',
            '0 0 16px 4px rgba(56,189,248,0.5)',
            '0 0 8px 2px rgba(56,189,248,0.3)',
        ],
        transition: { duration: 2, repeat: Infinity },
    },
};

// ── Default categories ──────────────────────────────────────────

function buildCategories(
    tacticalState: RadialHelmMenuProps['tacticalState'],
    chartsState: RadialHelmMenuProps['chartsState'],
): HelmCategory[] {
    const tactical: HelmMenuItem[] = [];

    // ─────────────────────────────────────────────────────────────────
    // Order matters — the radial fan presents items in this sequence,
    // so the FIRST items are the ones a user is most likely to want
    // when something is going wrong. Threat-critical layers first
    // (lightning, squall, storms, vessel-traffic awareness), then
    // operational reference layers (marks, tides, no-go zones,
    // diagnostic inspector).
    //
    // The radial menu doesn't yet have visual sub-categories, but the
    // ordering itself communicates priority — at a glance the user sees
    // the "things that might hurt me" cluster first.
    // ─────────────────────────────────────────────────────────────────

    // ── Threat-critical (top of the fan) ──
    if (tacticalState?.onToggleLightning) {
        tactical.push({
            id: 'lightning',
            label: 'Lightning',
            icon: <LightningIcon />,
            action: tacticalState.onToggleLightning,
        });
    }
    if (tacticalState?.onToggleSquall) {
        tactical.push({
            id: 'squall',
            label: 'Squall',
            icon: <SquallIcon />,
            action: tacticalState.onToggleSquall,
        });
    }
    if (tacticalState?.onToggleCyclones) {
        tactical.push({
            id: 'cyclones',
            label: 'Storms',
            icon: <CycloneIcon />,
            action: tacticalState.onToggleCyclones,
        });
    }
    if (tacticalState?.onToggleAis) {
        tactical.push({
            id: 'ais',
            label: 'AIS',
            icon: <AisIcon />,
            action: tacticalState.onToggleAis,
        });
    }

    // ── Operational reference (lower in the fan) ──
    if (tacticalState?.onToggleSeamark) {
        tactical.push({
            id: 'seamark',
            label: 'Marks',
            icon: <SeamarkIcon />,
            action: tacticalState.onToggleSeamark,
        });
    }
    if (tacticalState?.onToggleTideStations) {
        tactical.push({
            id: 'tides',
            label: 'Tides',
            icon: <TideIcon />,
            action: tacticalState.onToggleTideStations,
        });
    }
    if (tacticalState?.onToggleMpa) {
        tactical.push({
            id: 'mpa',
            label: 'No-Go',
            icon: <MpaIcon />,
            action: tacticalState.onToggleMpa,
        });
    }
    if (tacticalState?.onToggleWeatherInspect) {
        tactical.push({
            id: 'inspect',
            label: 'Inspect',
            icon: <InspectIcon />,
            action: tacticalState.onToggleWeatherInspect,
        });
    }

    return [
        {
            id: 'tactical',
            label: 'Tactical',
            icon: <TacticalCategoryIcon />,
            color: 'text-amber-400',
            glowColor: 'rgba(251,191,36,0.4)',
            items: tactical,
        },
        {
            id: 'sea',
            label: 'Sea', // Short — "Sea State" overflowed the 60px bubble at tracking-0.15em
            icon: <SeaCategoryIcon />,
            color: 'text-cyan-400',
            glowColor: 'rgba(34,211,238,0.4)',
            items: [
                {
                    id: 'waves',
                    label: 'Waves',
                    icon: <WavesIcon />,
                    layerKey: 'waves',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
                {
                    id: 'currents',
                    label: 'Currents',
                    icon: <CurrentsIcon />,
                    layerKey: 'currents',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
                {
                    id: 'sst',
                    label: 'SST',
                    icon: <SstIcon />,
                    layerKey: 'sst',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
                {
                    id: 'chl',
                    label: 'Chlorophyll',
                    icon: <ChlIcon />,
                    layerKey: 'chl',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
                {
                    id: 'seaice',
                    label: 'Sea Ice',
                    icon: <SeaIceIcon />,
                    layerKey: 'seaice',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
                {
                    id: 'mld',
                    label: 'MLD',
                    icon: <MldIcon />,
                    layerKey: 'mld',
                    groupExclusive: true,
                    group: SEA_STATE_LAYERS,
                },
            ],
        },
        {
            id: 'atmosphere',
            label: 'Sky', // Short — "Atmosphere" overflowed the 60px bubble
            icon: <AtmosphereCategoryIcon />,
            color: 'text-sky-400',
            glowColor: 'rgba(56,189,248,0.4)',
            items: [
                {
                    id: 'wind',
                    label: 'Wind',
                    icon: <WindIcon />,
                    layerKey: 'wind',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                // The old "Flow" entry (layerKey: 'velocity') was a duplicate —
                // both it and 'wind' pointed at the same particle engine +
                // GRIB fetch. Removed from the menu for clarity; the
                // 'velocity' layer key is still accepted in persisted state
                // so older saves don't break — WindDataController treats it
                // as an alias for 'wind'.
                {
                    id: 'rain',
                    label: 'Rain',
                    icon: <RainIcon />,
                    layerKey: 'rain',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                {
                    id: 'pressure',
                    label: 'Pressure',
                    icon: <PressureIcon />,
                    layerKey: 'pressure',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                {
                    id: 'clouds',
                    label: 'Clouds',
                    icon: <CloudsIcon />,
                    layerKey: 'clouds',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                {
                    id: 'temperature',
                    label: 'Temp',
                    icon: <TempIcon />,
                    layerKey: 'temperature',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                // Wind-gusts / Visibility / CAPE removed 2026-04-22 with
                // the Xweather decommission — they were Xweather-raster-only
                // and we don't have a free replacement. Add back when we
                // wire up GFS-derived gusts or similar.
            ],
        },
        // ── Charts (4th category) ──
        // Surfaces o-charts (AvNav/SignalK), free charts (NOAA, LINZ) and any
        // local MBTiles directly in the radial menu. Each source is a plain
        // on/off toggle — for opacity / fly-to / per-chart selection users
        // still have the legacy Chart FAB panel.
        ...buildChartsCategory(chartsState),
    ];
}

/** Build the "Charts" category. Returns an empty array if no sources exist,
 *  so the radial menu falls back to 3 categories when the user has no chart
 *  sources configured (keeps the arc layout clean). */
function buildChartsCategory(chartsState: RadialHelmMenuProps['chartsState']): HelmCategory[] {
    const sources = chartsState?.sources ?? [];
    if (sources.length === 0) return [];

    const items: HelmMenuItem[] = sources.map((src) => ({
        id: `chart-${src.id}`,
        label: src.label,
        icon: chartSourceIcon(src.iconKind),
        action: src.onToggle,
    }));

    return [
        {
            id: 'charts',
            label: 'Charts',
            icon: <ChartsCategoryIcon />,
            color: 'text-violet-400',
            glowColor: 'rgba(167,139,250,0.4)',
            items,
        },
    ];
}

/** Dispatch to the inline SVG icon for a chart-source kind. */
function chartSourceIcon(kind: 'avnav' | 'noaa' | 'ecdis' | 'linz' | 'local' | 'generic'): React.ReactNode {
    switch (kind) {
        case 'avnav':
            return <ChartAnchorIcon />;
        case 'noaa':
            return <ChartNoaaIcon />;
        case 'ecdis':
            return <ChartEcdisIcon />;
        case 'linz':
            return <ChartLinzIcon />;
        case 'local':
            return <ChartLocalIcon />;
        default:
            return <ChartGenericIcon />;
    }
}

// ── Component ────────────────────────────────────────────────────

export const RadialHelmMenu: React.FC<RadialHelmMenuProps> = ({
    activeLayers,
    toggleLayer,
    selectInGroup,
    tacticalState,
    chartsState,
    hidden = false,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeCategory, setActiveCategory] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [hoveredItem, setHoveredItem] = useState<string | null>(null);
    const fabRef = useRef<HTMLButtonElement>(null);
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragStartPos = useRef<{ x: number; y: number } | null>(null);

    const categories = useMemo(() => buildCategories(tacticalState, chartsState), [tacticalState, chartsState]);

    // ── Arc layout parameters ──
    // Categories fan out DOWN-LEFT from the FAB. With the FAB now anchored at
    // top-[128px] (below the legacy chart FAB), we have ~100px of headroom for
    // the upper arc and unlimited room below.
    //
    // Chord geometry for no-overlap:
    //   chord = 2 * R * sin(step/2)
    //   At 60px bubble-diameter + 15px gap, we want chord ≥ 75px.
    //   4 items, step = SPREAD/3. Solving gives R=125, SPREAD=105° as the
    //   minimum that gives clear visual separation at every pair.
    const TIER1_RADIUS = categories.length >= 4 ? 125 : 90;
    const TIER1_CENTER_ANGLE = 150; // Down-left (keeps arc below top edge)
    const TIER1_SPREAD = categories.length >= 4 ? 105 : 70;

    // Tier 2 items are now rendered in a grid, not an arc — these constants
    // are kept for the drag-hover zone detection in handlePointerMove.
    const TIER2_RADIUS = 80;
    const TIER2_CENTER_ANGLE = 145;
    const TIER2_SPREAD_PER_ITEM = 24;

    const tier1Angles = useMemo(
        () => distributeArc(categories.length, TIER1_CENTER_ANGLE, TIER1_SPREAD),
        [categories.length],
    );

    // ── Handlers ─────────────────────────────────────────────

    const handleTap = useCallback(() => {
        if (isDragging) return;
        setIsOpen((v) => {
            if (v) {
                setActiveCategory(null);
                setHoveredItem(null);
            }
            return !v;
        });
        triggerHaptic('light');
    }, [isDragging]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        holdTimer.current = setTimeout(() => {
            setIsOpen(true);
            setIsDragging(true);
            triggerHaptic('medium');
        }, 300);
    }, []);

    const handlePointerUp = useCallback(() => {
        if (holdTimer.current) {
            clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }

        if (isDragging) {
            // If hovering over an item, activate it
            if (hoveredItem) {
                const cat = categories.find((c) => c.id === activeCategory);
                const item = cat?.items.find((it) => it.id === hoveredItem);
                if (item) {
                    if (item.action) {
                        item.action();
                    } else if (item.layerKey) {
                        if (item.groupExclusive && item.group) {
                            selectInGroup(item.layerKey, item.group);
                        } else {
                            toggleLayer(item.layerKey);
                        }
                    }
                    triggerHaptic('medium');
                }
                // Close after selection
                setIsOpen(false);
                setActiveCategory(null);
                setHoveredItem(null);
            }
            setIsDragging(false);
        }

        dragStartPos.current = null;
    }, [isDragging, hoveredItem, activeCategory, categories, selectInGroup, toggleLayer]);

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDragging || !fabRef.current) return;

            const fabRect = fabRef.current.getBoundingClientRect();
            const fabCenterX = fabRect.left + fabRect.width / 2;
            const fabCenterY = fabRect.top + fabRect.height / 2;
            const dx = e.clientX - fabCenterX;
            const dy = e.clientY - fabCenterY;
            const dist = Math.hypot(dx, dy);

            // Check if hovering over a category (Tier 1 zone: 50-130px from center)
            if (dist > 50 && dist < 130 && !activeCategory) {
                const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                // Find closest category
                let closestIdx = 0;
                let closestDist = Infinity;
                tier1Angles.forEach((a, i) => {
                    const d = Math.abs(((angle - a + 540) % 360) - 180);
                    if (d < closestDist) {
                        closestDist = d;
                        closestIdx = i;
                    }
                });
                if (closestDist < 35) {
                    setActiveCategory(categories[closestIdx].id);
                    triggerHaptic('light');
                }
            }

            // Tier 2 items now live in a grid, not an arc — use DOM hit-testing
            // via elementFromPoint so the drag-hover works for any grid layout.
            if (activeCategory) {
                const el = document.elementFromPoint(e.clientX, e.clientY);
                const btn = el?.closest<HTMLButtonElement>('[data-helm-item]');
                const itemId = btn?.getAttribute('data-helm-item') || null;
                if (itemId !== hoveredItem) {
                    setHoveredItem(itemId);
                    if (itemId) triggerHaptic('light');
                }
            }
        },
        [isDragging, activeCategory, categories, tier1Angles, hoveredItem],
    );

    const handleCategoryTap = useCallback((catId: string) => {
        setActiveCategory((prev) => (prev === catId ? null : catId));
        triggerHaptic('light');
    }, []);

    const handleItemTap = useCallback(
        (item: HelmMenuItem) => {
            if (item.action) {
                item.action();
            } else if (item.layerKey) {
                if (item.groupExclusive && item.group) {
                    selectInGroup(item.layerKey, item.group);
                } else {
                    toggleLayer(item.layerKey);
                }
            }
            triggerHaptic('medium');

            // Close on selection
            setIsOpen(false);
            setActiveCategory(null);
            setHoveredItem(null);
        },
        [selectInGroup, toggleLayer],
    );

    // ── Check if an item is "active" ──
    const isItemActive = useCallback(
        (item: HelmMenuItem): boolean => {
            if (item.layerKey) return activeLayers.has(item.layerKey);
            if (item.id === 'ais') return tacticalState?.aisVisible ?? false;
            if (item.id === 'cyclones') return tacticalState?.cycloneVisible ?? false;
            if (item.id === 'squall') return tacticalState?.squallVisible ?? false;
            if (item.id === 'lightning') return tacticalState?.lightningVisible ?? false;
            if (item.id === 'inspect') return tacticalState?.weatherInspectMode ?? false;
            if (item.id === 'seamark') return tacticalState?.seamarkVisible ?? false;
            if (item.id === 'tides') return tacticalState?.tideStationsVisible ?? false;
            if (item.id === 'mpa') return tacticalState?.mpaVisible ?? false;
            // Charts — items are id'd as chart-<sourceId>; match against chartsState.
            if (item.id.startsWith('chart-')) {
                const srcId = item.id.slice('chart-'.length);
                return chartsState?.sources?.find((s) => s.id === srcId)?.enabled ?? false;
            }
            return false;
        },
        [activeLayers, tacticalState, chartsState],
    );

    // Total active count (for badge)
    const totalActive = useMemo(() => {
        let count = activeLayers.size;
        if (tacticalState?.aisVisible) count++;
        if (tacticalState?.cycloneVisible) count++;
        if (tacticalState?.squallVisible) count++;
        if (tacticalState?.lightningVisible) count++;
        if (tacticalState?.weatherInspectMode) count++;
        if (tacticalState?.seamarkVisible) count++;
        if (tacticalState?.tideStationsVisible) count++;
        // Active chart sources count too — so the FAB badge reflects them.
        if (chartsState?.sources) {
            for (const s of chartsState.sources) if (s.enabled) count++;
        }
        return count;
    }, [activeLayers, tacticalState, chartsState]);

    // Any active items in a category?
    const categoryHasActive = useCallback(
        (cat: HelmCategory): boolean => cat.items.some((item) => isItemActive(item)),
        [isItemActive],
    );

    // Capture pointer so drag gestures track beyond the FAB's bounding box
    const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, []);

    if (hidden) return null;

    // ── Render ───────────────────────────────────────────────

    return (
        <div
            className={`absolute z-[700] top-[128px] right-3 ${isOpen ? 'pointer-events-auto' : ''}`}
            onPointerDown={handleContainerPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ touchAction: 'none' }}
        >
            {/* ── Scrim (click-away to close) ── */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        className="fixed inset-0 z-[-1]"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        onClick={() => {
                            setIsOpen(false);
                            setActiveCategory(null);
                            setHoveredItem(null);
                        }}
                    />
                )}
            </AnimatePresence>

            {/* ── Tier 2: Layer Items ──
                A compact 2-column grid anchored below the FAB. Replaces the
                previous arc layout which mathematically couldn't fit >6 items
                (52px buttons × 9 atmosphere items overlap severely in any
                on-screen arc). The grid: (a) always touchable regardless of
                item count, (b) preserves tight spacing, (c) keeps the gesture-
                drag semantics via hit-testing in handlePointerMove which now
                uses geometric hit-testing against grid cells.
            */}
            <AnimatePresence>
                {isOpen &&
                    activeCategory &&
                    (() => {
                        const cat = categories.find((c) => c.id === activeCategory);
                        if (!cat) return null;

                        return (
                            <motion.div
                                key={`grid-${cat.id}`}
                                className="fixed flex flex-col gap-2 rounded-2xl border border-white/15 bg-slate-900/95 p-3 backdrop-blur-xl shadow-2xl"
                                style={{
                                    // Anchor the grid to the right edge of the viewport, BELOW the
                                    // Tier 1 category arc. Fixed (not absolute) so it escapes the
                                    // 48px FAB container.
                                    right: 12,
                                    // FAB now at top-[128], arc radius 125 → lowest bubble center at
                                    // y ≈ 128 + sin(97.5°)*125 = ~251, plus 30px bubble half-height
                                    // = 281 bottom. Anchor grid at 300 with a 20px gap.
                                    top: 300,
                                    // Span most of the viewport width on phones; cap on tablets.
                                    width: 'calc(100vw - 24px)',
                                    maxWidth: 360,
                                }}
                                initial={{ opacity: 0, scale: 0.92, y: -8 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.92, y: -8 }}
                                transition={SPRING_SNAPPY}
                            >
                                {/* Header chip: active category label + count */}
                                <div className="flex items-center justify-between px-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`text-lg ${cat.color}`}>{cat.icon}</span>
                                        <span className="text-[11px] font-black uppercase tracking-[0.18em] text-white/90">
                                            {cat.label}
                                        </span>
                                    </div>
                                    <span className="text-[10px] font-semibold text-gray-500">
                                        {cat.items.length} layers
                                    </span>
                                </div>

                                {/* 3-column grid gives 9 items 3 rows with breathing room;
                                    auto-fit lets it degrade to 2 cols gracefully on very
                                    narrow viewports. */}
                                <div
                                    className="grid gap-2"
                                    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))' }}
                                >
                                    {cat.items.map((item, i) => {
                                        const active = isItemActive(item);
                                        const hovered = hoveredItem === item.id;
                                        return (
                                            <motion.button
                                                key={`item-${item.id}`}
                                                data-helm-item={item.id}
                                                custom={i}
                                                variants={itemVariants}
                                                initial="hidden"
                                                animate="visible"
                                                exit="exit"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleItemTap(item);
                                                }}
                                                className={`relative flex h-16 flex-col items-center justify-center gap-1 rounded-xl border transition-colors ${
                                                    active
                                                        ? 'bg-sky-500/20 border-sky-400/50 text-white'
                                                        : hovered
                                                          ? 'bg-white/10 border-white/25 text-white'
                                                          : 'bg-slate-800/70 border-white/[0.08] text-gray-300'
                                                }`}
                                                whileHover={{ scale: 1.04 }}
                                                whileTap={{ scale: 0.94 }}
                                            >
                                                <span className="text-[18px] leading-none">{item.icon}</span>
                                                <span className="text-[10px] font-bold uppercase tracking-wider leading-none">
                                                    {item.label}
                                                </span>
                                                {active && (
                                                    <motion.span
                                                        className="absolute top-1 right-1 h-2 w-2 rounded-full bg-sky-400"
                                                        layoutId={`active-dot-${item.id}`}
                                                        animate={{
                                                            boxShadow: [
                                                                '0 0 4px 1px rgba(56,189,248,0.4)',
                                                                '0 0 8px 2px rgba(56,189,248,0.6)',
                                                                '0 0 4px 1px rgba(56,189,248,0.4)',
                                                            ],
                                                        }}
                                                        transition={{ duration: 2, repeat: Infinity }}
                                                    />
                                                )}
                                            </motion.button>
                                        );
                                    })}
                                </div>

                                {/* Footer — "Clear All" pill lives INSIDE the grid panel now so
                                    it can never overlap the Tier 1 arc or the categories. Shows
                                    only when at least one layer is active. */}
                                {totalActive > 0 && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleLayer('none');
                                            if (tacticalState?.aisVisible) tacticalState.onToggleAis?.();
                                            if (tacticalState?.cycloneVisible) tacticalState.onToggleCyclones?.();
                                            if (tacticalState?.squallVisible) tacticalState.onToggleSquall?.();
                                            if (tacticalState?.lightningVisible) tacticalState.onToggleLightning?.();
                                            if (tacticalState?.weatherInspectMode)
                                                tacticalState.onToggleWeatherInspect?.();
                                            if (tacticalState?.seamarkVisible) tacticalState.onToggleSeamark?.();
                                            if (tacticalState?.tideStationsVisible)
                                                tacticalState.onToggleTideStations?.();
                                            // Also clear any chart sources.
                                            chartsState?.sources?.forEach((s) => {
                                                if (s.enabled) s.onToggle();
                                            });
                                            triggerHaptic('medium');
                                            setIsOpen(false);
                                            setActiveCategory(null);
                                        }}
                                        className="mt-1 w-full rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-400 transition-colors hover:bg-red-500/20"
                                    >
                                        Clear All · {totalActive} active
                                    </button>
                                )}
                            </motion.div>
                        );
                    })()}
            </AnimatePresence>

            {/* ── Tier 1: Category Nodes (arc from FAB) ── */}
            <AnimatePresence>
                {isOpen &&
                    categories.map((cat, i) => {
                        const pos = polarToXY(tier1Angles[i], TIER1_RADIUS);
                        const isActive = activeCategory === cat.id;
                        const hasActive = categoryHasActive(cat);

                        return (
                            <motion.button
                                key={`cat-${cat.id}`}
                                custom={i}
                                variants={categoryVariants}
                                initial="hidden"
                                animate="visible"
                                exit="exit"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleCategoryTap(cat.id);
                                }}
                                className={`absolute flex flex-col items-center justify-center rounded-2xl border transition-colors ${
                                    isActive
                                        ? `bg-slate-800/90 border-white/20 ${cat.color}`
                                        : hasActive
                                          ? `bg-slate-900/80 border-white/10 ${cat.color}`
                                          : 'bg-slate-900/70 border-white/[0.08] text-gray-500'
                                } backdrop-blur-xl`}
                                style={{
                                    width: 60,
                                    height: 60,
                                    // Position: FAB is at right:12px, so offset leftward
                                    right: -pos.x - 6,
                                    top: pos.y - 6,
                                }}
                                whileHover={{ scale: 1.1 }}
                                whileTap={{ scale: 0.92 }}
                            >
                                <motion.div
                                    variants={glowPulse}
                                    animate={isActive ? 'active' : 'inactive'}
                                    className="flex flex-col items-center justify-center w-full h-full rounded-2xl"
                                    style={isActive ? { boxShadow: `0 0 12px 2px ${cat.glowColor}` } : {}}
                                >
                                    <span className="text-xl leading-none">{cat.icon}</span>
                                    {/* Category label — tight tracking so longer words ("Tactical",
                                        "Charts") fit inside the 60px bubble without hanging over
                                        the edges. Width clamp + truncate is a safety net for any
                                        future label that still overflows. */}
                                    <span className="mt-1 max-w-[52px] truncate text-[8px] font-black uppercase leading-none tracking-wider">
                                        {cat.label}
                                    </span>
                                </motion.div>
                                {hasActive && !isActive && (
                                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-sky-400 shadow-lg shadow-sky-400/50" />
                                )}
                            </motion.button>
                        );
                    })}
            </AnimatePresence>

            {/* ── FAB (helm wheel) ── */}
            <motion.button
                ref={fabRef}
                aria-label="Toggle layer menu"
                variants={fabVariants}
                animate={isOpen ? 'active' : 'idle'}
                transition={SPRING_TIGHT}
                onClick={handleTap}
                onPointerDown={handlePointerDown}
                className="relative w-12 h-12 rounded-2xl bg-slate-900/90 backdrop-blur-xl border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-colors active:scale-95"
                style={{ touchAction: 'none' }}
            >
                <HelmWheelIcon isOpen={isOpen} />
                {totalActive > 0 && (
                    <motion.span
                        className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-sky-500 rounded-full flex items-center justify-center text-[11px] font-black text-white shadow-lg shadow-sky-500/50"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={SPRING_SNAPPY}
                    >
                        {totalActive}
                    </motion.span>
                )}
            </motion.button>

            {/* ── Tier-1 Clear All pill ── Shown only when the menu is open,
                NO category is selected (so the tier-2 grid isn't on screen),
                AND there are active layers. Positioned below the category arc —
                with FAB at top-[128] + radius 125, the bottom-most bubble
                reaches ~281; this pill sits clear at 320px. */}
            <AnimatePresence>
                {isOpen && !activeCategory && totalActive > 0 && (
                    <motion.button
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ ...SPRING_SNAPPY, delay: 0.2 }}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleLayer('none');
                            if (tacticalState?.aisVisible) tacticalState.onToggleAis?.();
                            if (tacticalState?.cycloneVisible) tacticalState.onToggleCyclones?.();
                            if (tacticalState?.squallVisible) tacticalState.onToggleSquall?.();
                            if (tacticalState?.lightningVisible) tacticalState.onToggleLightning?.();
                            if (tacticalState?.weatherInspectMode) tacticalState.onToggleWeatherInspect?.();
                            if (tacticalState?.seamarkVisible) tacticalState.onToggleSeamark?.();
                            if (tacticalState?.tideStationsVisible) tacticalState.onToggleTideStations?.();
                            chartsState?.sources?.forEach((s) => {
                                if (s.enabled) s.onToggle();
                            });
                            triggerHaptic('medium');
                            setIsOpen(false);
                            setActiveCategory(null);
                        }}
                        className="fixed right-3 whitespace-nowrap rounded-xl border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-red-400 backdrop-blur-md shadow-lg transition-colors hover:bg-red-500/25"
                        style={{ top: 320 }}
                    >
                        Clear All · {totalActive}
                    </motion.button>
                )}
            </AnimatePresence>
        </div>
    );
};

// ── SVG Icons (compact, monochrome, optimized for 20-24px) ──────

const HelmWheelIcon: React.FC<{ isOpen: boolean }> = ({ isOpen }) => (
    <motion.svg
        className="w-5 h-5 text-white"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        animate={{ rotate: isOpen ? 45 : 0 }}
        transition={SPRING_TIGHT}
    >
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3"
        />
    </motion.svg>
);

// Category icons
const TacticalCategoryIcon = () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
        />
    </svg>
);

const SeaCategoryIcon = () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 17.25c1.5-1.5 3-2.25 4.5-2.25s3 .75 4.5 2.25c1.5 1.5 3 2.25 4.5 2.25s3-.75 4.5-2.25M3 12c1.5-1.5 3-2.25 4.5-2.25S10.5 10.5 12 12c1.5 1.5 3 2.25 4.5 2.25S19.5 13.5 21 12M3 6.75c1.5-1.5 3-2.25 4.5-2.25s3 .75 4.5 2.25c1.5 1.5 3 2.25 4.5 2.25s3-.75 4.5-2.25"
        />
    </svg>
);

const AtmosphereCategoryIcon = () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"
        />
    </svg>
);

// 4th category: stacked-layers "charts" glyph — echoes the legacy chart FAB icon.
const ChartsCategoryIcon = () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3"
        />
    </svg>
);

// Chart source icons — mirrors ChartSourceIcons.tsx but inlined so RadialHelmMenu
// stays a single self-contained file.
const ChartAnchorIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <circle cx={12} cy={5} r={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.5v14M8.5 10h7" />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 14.5c0 3.5 3 6 7 6s7-2.5 7-6M5 14.5l-1.5 1.5M5 14.5h2m12 0l1.5 1.5M19 14.5h-2"
        />
    </svg>
);
const ChartNoaaIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <circle cx={12} cy={12} r={8.5} />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 7.5l1.18 2.39 2.64.38-1.91 1.86.45 2.63L12 13.52l-2.36 1.24.45-2.63-1.91-1.86 2.64-.38L12 7.5z"
            fill="currentColor"
            fillOpacity={0.15}
        />
    </svg>
);
const ChartEcdisIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <rect x={3.5} y={3.5} width={17} height={17} rx={2} />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 9h17M3.5 15h17M9 3.5v17M15 3.5v17" />
    </svg>
);
const ChartLinzIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18" />
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6c-1.5 1-3 1.5-4.5 1.5M12 6c1.5 1 3 1.5 4.5 1.5M12 10c-2 1.3-4 1.8-6 1.8M12 10c2 1.3 4 1.8 6 1.8M12 14.5c-2 1.3-4 1.8-5.5 1.8M12 14.5c2 1.3 4 1.8 5.5 1.8"
        />
    </svg>
);
const ChartLocalIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 8.25V6A1.5 1.5 0 015.25 4.5h4.19a1.5 1.5 0 011.06.44l1.56 1.56h6.69A1.5 1.5 0 0120.25 8v9.75A1.5 1.5 0 0118.75 19.25H5.25a1.5 1.5 0 01-1.5-1.5v-9.5z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6M12 10v6" />
    </svg>
);
const ChartGenericIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6.75L3.75 9v11.25l5.25-2.25 6 2.25 5.25-2.25V6.75l-5.25 2.25-6-2.25z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75v11.25M15 9v11.25" />
    </svg>
);

// Layer item icons
const AisIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71L12 2z" />
    </svg>
);

const CycloneIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0M12 3c4 0 7 2 8 5-2-1-4-1.5-6-.5M12 21c-4 0-7-2-8-5 2 1 4 1.5 6 .5M3 12c0-4 2-7 5-8-1 2-1.5 4-.5 6M21 12c0 4-2 7-5 8 1-2 1.5-4 .5-6"
        />
    </svg>
);

const SquallIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8h14M3 12h18M3 16h10" />
    </svg>
);

const LightningIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
        />
    </svg>
);

const InspectIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l5 5M10 17a7 7 0 100-14 7 7 0 000 14z" />
    </svg>
);

const SeamarkIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M8 7l4-4 4 4M6 21h12" />
    </svg>
);

const TideIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 17c2-3 5-3 7 0s5 3 7 0M3 12c2-3 5-3 7 0s5 3 7 0M12 3v5"
        />
    </svg>
);

const WavesIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 15c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0M3 9c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0"
        />
    </svg>
);

const CurrentsIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5-5 5M6 7l5 5-5 5" />
    </svg>
);

const SstIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9a3 3 0 100 6M12 3v2M12 19v2M5.636 5.636l1.414 1.414M16.95 16.95l1.414 1.414M3 12h2M19 12h2M5.636 18.364l1.414-1.414M16.95 7.05l1.414-1.414"
        />
    </svg>
);

// Leaf/algae glyph — chlorophyll. Stylised phytoplankton cell with
// a midrib (chloroplast) and an outer membrane.
const ChlIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 20c0-6 3-12 10-14-1 8-5 13-10 14zM7 20l10-14M7 20s1-3 4-5M13 13s-1 1-2 3"
        />
    </svg>
);

// Six-pointed snowflake glyph — sea ice. Three crossing axes give
// the canonical winter snowflake silhouette without spiky branches
// crowding the 16px box.
const SeaIceIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 3v18M5.2 7l13.6 10M5.2 17 18.8 7M9 5l3-2 3 2M9 19l3 2 3-2M5 9.5 3 12l2 2.5M19 9.5l2 2.5-2 2.5"
        />
    </svg>
);

// Stacked-strata glyph — mixed-layer depth. Three horizontal layers
// with a downward arrow on the right edge: surface mixed pool above,
// thermocline boundary, deeper water below. Reads as "depth profile".
const MldIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h14M3 12h12M3 17h10M19 5v14M16 16l3 3 3-3" />
    </svg>
);

// "No-go" / marine reserve glyph — fish silhouette inside a slashed
// circle. Reads at-a-glance as "fishing restricted here".
const MpaIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        {/* Outer prohibition circle */}
        <circle cx="12" cy="12" r="9" />
        {/* Diagonal slash */}
        <path strokeLinecap="round" d="M5.5 5.5l13 13" />
        {/* Fish body — simple oval with tail wedge */}
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.5 12c1.5-2 4-2.6 6-1.6 0.8 0.4 1.4 1 1.6 1.6-0.2 0.6-0.8 1.2-1.6 1.6-2 1-4.5 0.4-6-1.6zM16.1 12l1.7-1v2l-1.7-1z"
        />
    </svg>
);

const WindIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.59 4.59A2 2 0 1111 8H2m10.59 11.41A2 2 0 1014 16H2m15.73-8.27A2.5 2.5 0 1119.5 12H2"
        />
    </svg>
);

const VelocityIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h6l3-9 3 18 3-9h6" />
    </svg>
);

const RainIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 13.5C4.5 11 6.5 9 9 9h.5a5.5 5.5 0 0110.96.68A3.5 3.5 0 0119 16H6a3.5 3.5 0 01-1.5-6.5zM8 19v2M12 19v2M16 19v2"
        />
    </svg>
);

const PressureIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0M12 7v5l3 3" />
    </svg>
);

const CloudsIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"
        />
    </svg>
);

const TempIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9a3 3 0 100 6 3 3 0 000-6zM12 3v2M12 19v2M5.636 5.636l1.414 1.414M16.95 16.95l1.414 1.414M3 12h2M19 12h2"
        />
    </svg>
);

// GustsIcon / VisibilityIcon / CapeIcon removed 2026-04-22 with the
// Xweather decommission — the layers they represented were Xweather-only.

export default RadialHelmMenu;
