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

function buildCategories(tacticalState: RadialHelmMenuProps['tacticalState']): HelmCategory[] {
    const tactical: HelmMenuItem[] = [];

    // Only include tactical items that have callbacks provided
    if (tacticalState?.onToggleAis) {
        tactical.push({
            id: 'ais',
            label: 'AIS',
            icon: <AisIcon />,
            action: tacticalState.onToggleAis,
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
    if (tacticalState?.onToggleSquall) {
        tactical.push({
            id: 'squall',
            label: 'Squall',
            icon: <SquallIcon />,
            action: tacticalState.onToggleSquall,
        });
    }
    if (tacticalState?.onToggleLightning) {
        tactical.push({
            id: 'lightning',
            label: 'Lightning',
            icon: <LightningIcon />,
            action: tacticalState.onToggleLightning,
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
            label: 'Sea State',
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
            ],
        },
        {
            id: 'atmosphere',
            label: 'Atmosphere',
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
                {
                    id: 'velocity',
                    label: 'Flow',
                    icon: <VelocityIcon />,
                    layerKey: 'velocity',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
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
                {
                    id: 'wind-gusts',
                    label: 'Gusts',
                    icon: <GustsIcon />,
                    layerKey: 'wind-gusts',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                {
                    id: 'visibility',
                    label: 'Vis',
                    icon: <VisibilityIcon />,
                    layerKey: 'visibility',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
                {
                    id: 'cape',
                    label: 'CAPE',
                    icon: <CapeIcon />,
                    layerKey: 'cape',
                    groupExclusive: true,
                    group: ATMOSPHERE_LAYERS,
                },
            ],
        },
    ];
}

// ── Component ────────────────────────────────────────────────────

export const RadialHelmMenu: React.FC<RadialHelmMenuProps> = ({
    activeLayers,
    toggleLayer,
    selectInGroup,
    tacticalState,
    hidden = false,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeCategory, setActiveCategory] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [hoveredItem, setHoveredItem] = useState<string | null>(null);
    const fabRef = useRef<HTMLButtonElement>(null);
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragStartPos = useRef<{ x: number; y: number } | null>(null);

    const categories = useMemo(() => buildCategories(tacticalState), [tacticalState]);

    // ── Arc layout parameters ──
    // Categories fan out DOWN-LEFT from the FAB (since it's on the right edge, near the top).
    // In CSS screen coords: sin(angle) > 0 for angles 0°–180° pushes items DOWN.
    // Center angle 150° keeps the arc below the FAB, preventing items going off-screen.
    const TIER1_RADIUS = 90;
    const TIER1_CENTER_ANGLE = 150; // Down-left (keeps arc below top edge)
    const TIER1_SPREAD = 70; // degrees of arc

    // Tier 2 items fan out further from the selected category
    const TIER2_RADIUS = 80;
    const TIER2_CENTER_ANGLE = 145;
    const TIER2_SPREAD_PER_ITEM = 24; // degrees between items

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

            // Check if hovering over a Tier 2 item (130-200px from center)
            if (dist > 100 && activeCategory) {
                const cat = categories.find((c) => c.id === activeCategory);
                if (cat) {
                    const catIdx = categories.findIndex((c) => c.id === activeCategory);
                    const catAngle = tier1Angles[catIdx];
                    const catPos = polarToXY(catAngle, TIER1_RADIUS);

                    // Relative to category node
                    const rdx = e.clientX - (fabCenterX + catPos.x);
                    const rdy = e.clientY - (fabCenterY + catPos.y);
                    const rdist = Math.hypot(rdx, rdy);

                    if (rdist < TIER2_RADIUS + 40) {
                        const rAngle = (Math.atan2(rdy, rdx) * 180) / Math.PI;
                        const itemSpread = Math.min(TIER2_SPREAD_PER_ITEM * (cat.items.length - 1), 120);
                        const itemAngles = distributeArc(cat.items.length, TIER2_CENTER_ANGLE, itemSpread);

                        let closestItemIdx = 0;
                        let closestItemDist = Infinity;
                        itemAngles.forEach((a, i) => {
                            const d = Math.abs(((rAngle - a + 540) % 360) - 180);
                            if (d < closestItemDist) {
                                closestItemDist = d;
                                closestItemIdx = i;
                            }
                        });
                        if (closestItemDist < 30) {
                            const newHover = cat.items[closestItemIdx].id;
                            if (newHover !== hoveredItem) {
                                setHoveredItem(newHover);
                                triggerHaptic('light');
                            }
                        } else {
                            setHoveredItem(null);
                        }
                    }
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
            return false;
        },
        [activeLayers, tacticalState],
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
        return count;
    }, [activeLayers, tacticalState]);

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
            className={`absolute z-[700] top-[56px] right-3 ${isOpen ? 'pointer-events-auto' : ''}`}
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

            {/* ── Tier 2: Layer Items (fanned from active category) ── */}
            <AnimatePresence>
                {isOpen &&
                    activeCategory &&
                    (() => {
                        const catIdx = categories.findIndex((c) => c.id === activeCategory);
                        const cat = categories[catIdx];
                        if (!cat) return null;

                        const catAngle = tier1Angles[catIdx];
                        const catPos = polarToXY(catAngle, TIER1_RADIUS);
                        const itemSpread = Math.min(TIER2_SPREAD_PER_ITEM * (cat.items.length - 1), 120);
                        const itemAngles = distributeArc(cat.items.length, TIER2_CENTER_ANGLE, itemSpread);

                        return cat.items.map((item, i) => {
                            const pos = polarToXY(itemAngles[i], TIER2_RADIUS);
                            const active = isItemActive(item);
                            const hovered = hoveredItem === item.id;

                            return (
                                <motion.button
                                    key={`item-${item.id}`}
                                    custom={i}
                                    variants={itemVariants}
                                    initial="hidden"
                                    animate="visible"
                                    exit="exit"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleItemTap(item);
                                    }}
                                    className={`absolute flex flex-col items-center justify-center rounded-xl border transition-colors ${
                                        active
                                            ? 'bg-sky-500/20 border-sky-400/40 text-white'
                                            : hovered
                                              ? 'bg-white/10 border-white/20 text-white'
                                              : 'bg-slate-900/70 border-white/[0.08] text-gray-400'
                                    } backdrop-blur-md`}
                                    style={{
                                        width: 52,
                                        height: 52,
                                        // Position relative to FAB center, offset by category position + item position
                                        right: -(catPos.x + pos.x) + 6,
                                        top: catPos.y + pos.y - 2,
                                    }}
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.92 }}
                                >
                                    <span className="text-base leading-none">{item.icon}</span>
                                    <span className="text-[8px] font-bold mt-0.5 uppercase tracking-wider leading-none">
                                        {item.label}
                                    </span>
                                    {active && (
                                        <motion.span
                                            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sky-400"
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
                        });
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
                                    <span className="text-[8px] font-black mt-1 uppercase tracking-[0.15em] leading-none">
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

            {/* ── "Clear All" strip at bottom when open with active layers ── */}
            <AnimatePresence>
                {isOpen && totalActive > 0 && (
                    <motion.button
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ ...SPRING_TIGHT, delay: 0.1 }}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleLayer('none');
                            // Also clear tactical states
                            if (tacticalState?.aisVisible) tacticalState.onToggleAis?.();
                            if (tacticalState?.cycloneVisible) tacticalState.onToggleCyclones?.();
                            if (tacticalState?.squallVisible) tacticalState.onToggleSquall?.();
                            if (tacticalState?.lightningVisible) tacticalState.onToggleLightning?.();
                            if (tacticalState?.weatherInspectMode) tacticalState.onToggleWeatherInspect?.();
                            if (tacticalState?.seamarkVisible) tacticalState.onToggleSeamark?.();
                            if (tacticalState?.tideStationsVisible) tacticalState.onToggleTideStations?.();
                            triggerHaptic('medium');
                            setIsOpen(false);
                            setActiveCategory(null);
                        }}
                        className="mt-2 px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20 backdrop-blur-md text-red-400 text-[10px] font-black uppercase tracking-widest hover:bg-red-500/20 transition-colors"
                    >
                        Clear All
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

const GustsIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 8h12a2 2 0 100-4M4 12h16a2 2 0 110 4M4 16h8a2 2 0 110 4"
        />
    </svg>
);

const VisibilityIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
);

const CapeIcon = () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
        />
    </svg>
);

export default RadialHelmMenu;
