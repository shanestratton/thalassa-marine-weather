/**
 * SavedLocationsPicker — combined save / recall affordance for the
 * route planner's origin and destination inputs.
 *
 * Single ★ button per input, opens a portaled popover that:
 *   • Saves whatever's currently in the input as a favourite (parses
 *     embedded coords from the planner's "Name (lat, lon)" string).
 *   • Lists the user's saved locations; tap to fill the input with
 *     the same "Name (lat, lon)" format so routing gets precise coords.
 *
 * Implementation notes (gotchas the first pass hit):
 *
 * 1. Renders the popover through createPortal into <body>. The
 *    button's wrapper sits inside the input's nested layout with
 *    several ancestor `relative` / overflow contexts; positioning
 *    the popover absolutely from there left it behind sibling
 *    elements on the destination input. Portaling escapes all of
 *    that, and `position: fixed` lets us anchor it precisely to the
 *    button's viewport rect.
 *
 * 2. No nested <button> elements. The first pass put the Remove
 *    button inside the Pick button, which is invalid HTML — WKWebView
 *    rewrote the DOM and the outer click handler stopped firing.
 *    Each row is now a div wrapper with two sibling buttons.
 *
 * 3. Remove icon is always-visible, not hover-gated. iOS has no
 *    hover state, so `group-hover:opacity-100` would have left the
 *    icon permanently invisible on touch.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapPinIcon, TrashIcon } from '../Icons';
import { useSettings } from '../../context/SettingsContext';
import {
    buildRemoveLocationPatch,
    buildSaveLocationPatch,
    extractDisplayName,
    hydrateSavedLocations,
    toPlannerString,
} from '../../utils/savedLocations';
import { triggerHaptic } from '../../utils/system';
import { useMenuNavigation } from '../../hooks/useMenuNavigation';

interface SavedLocationsPickerProps {
    /** Current input value (the planner's "Name (lat, lon)" format). */
    value: string;
    /** Setter for the input value — wired to setOrigin / setDestination. */
    onPick: (plannerString: string) => void;
    /** Departure / arrival side — used for the accent color + a11y label. */
    target: 'origin' | 'destination';
}

const ACCENTS = {
    origin: {
        text: 'text-emerald-400',
        fill: 'fill-emerald-400 text-emerald-400',
        textHover: 'hover:text-emerald-400',
    },
    destination: {
        text: 'text-purple-400',
        fill: 'fill-purple-400 text-purple-400',
        textHover: 'hover:text-purple-400',
    },
} as const;

export const SavedLocationsPicker: React.FC<SavedLocationsPickerProps> = ({ value, onPick, target }) => {
    const { settings, updateSettings } = useSettings();
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const popoverRef = useMenuNavigation<HTMLDivElement>(open, {
        triggerRef: buttonRef,
        onClose: () => setOpen(false),
    });
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    const savedList = useMemo(
        () => hydrateSavedLocations(settings.savedLocations, settings.savedLocationCoords),
        [settings.savedLocations, settings.savedLocationCoords],
    );

    const currentName = extractDisplayName(value);
    const alreadySaved = useMemo(
        () => currentName.length > 0 && savedList.some((s) => s.name.toLowerCase() === currentName.toLowerCase()),
        [currentName, savedList],
    );

    // Anchor the popover to the button's viewport rect. Re-measure on
    // open + on scroll/resize so the popover follows if the user
    // scrolls or rotates while it's up.
    useLayoutEffect(() => {
        if (!open) return;
        const measure = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) setAnchorRect(rect);
        };
        measure();
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
        return () => {
            window.removeEventListener('scroll', measure, true);
            window.removeEventListener('resize', measure);
        };
    }, [open]);

    // Close on outside-click. The popover lives in a portal
    // so we check BOTH the button AND the popover for the click
    // target — anything outside both is "outside".
    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent | TouchEvent) => {
            const target = e.target as Node;
            const inButton = buttonRef.current?.contains(target);
            const inPopover = popoverRef.current?.contains(target);
            if (!inButton && !inPopover) setOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('touchstart', handleClick);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('touchstart', handleClick);
        };
    }, [open, popoverRef]);

    const closeAndRestore = () => {
        setOpen(false);
        requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
    };

    const handleSaveCurrent = () => {
        if (!currentName) return;
        triggerHaptic('light');
        const patch = buildSaveLocationPatch(settings.savedLocations, settings.savedLocationCoords, value);
        if (patch) updateSettings(patch);
        closeAndRestore();
    };

    const handleUnsaveCurrent = () => {
        if (!currentName) return;
        triggerHaptic('light');
        const patch = buildRemoveLocationPatch(settings.savedLocations, settings.savedLocationCoords, currentName);
        updateSettings(patch);
        closeAndRestore();
    };

    const handlePick = (locName: string) => {
        const loc = savedList.find((s) => s.name === locName);
        if (!loc) return;
        triggerHaptic('light');
        onPick(toPlannerString(loc));
        closeAndRestore();
    };

    const handleRemove = (locName: string) => {
        triggerHaptic('light');
        const patch = buildRemoveLocationPatch(settings.savedLocations, settings.savedLocationCoords, locName);
        updateSettings(patch);
        closeAndRestore();
    };

    const accent = ACCENTS[target];

    // Position the portaled popover relative to the button's rect.
    // Anchor to the BUTTON'S right edge — popover extends left from
    // there so it stays inside the viewport on the destination side.
    // Cap to 8px from each viewport edge so we never bleed off-screen.
    const POPOVER_WIDTH = 288;
    const POPOVER_GAP = 8;
    const popoverStyle: React.CSSProperties = anchorRect
        ? (() => {
              const viewportW = window.innerWidth;
              const rightEdge = viewportW - anchorRect.right;
              const minRight = 8;
              const maxRight = Math.max(minRight, viewportW - POPOVER_WIDTH - 8);
              return {
                  position: 'fixed',
                  top: anchorRect.bottom + POPOVER_GAP,
                  right: Math.min(Math.max(rightEdge, minRight), maxRight),
                  width: POPOVER_WIDTH,
                  maxWidth: 'calc(100vw - 16px)',
                  zIndex: 9999,
              };
          })()
        : { display: 'none' };

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    triggerHaptic('light');
                    setOpen((v) => !v);
                }}
                className={`p-2 transition-colors hover:bg-white/10 rounded-lg ${
                    alreadySaved ? accent.fill : `text-gray-400 ${accent.textHover}`
                }`}
                title={`Save / recall ${target === 'origin' ? 'departure' : 'destination'}`}
                aria-label={`Save or recall a saved ${target === 'origin' ? 'departure' : 'destination'} location`}
                aria-expanded={open}
                aria-haspopup="menu"
                aria-controls={open ? menuId : undefined}
            >
                <StarIcon className="w-4 h-4" filled={alreadySaved} />
            </button>

            {open &&
                createPortal(
                    <div
                        id={menuId}
                        ref={popoverRef}
                        style={popoverStyle}
                        className="rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl overflow-hidden text-white"
                        role="menu"
                        aria-label={`Saved ${target} locations`}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Save / unsave the current input value */}
                        <div role="none" className="p-3 border-b border-white/10">
                            {currentName ? (
                                alreadySaved ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={handleUnsaveCurrent}
                                        className="w-full flex items-center justify-between gap-2 text-left p-2 rounded-lg hover:bg-red-500/10 transition-colors"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-0.5">
                                                Already saved
                                            </div>
                                            <div className="text-sm font-medium text-white truncate">{currentName}</div>
                                        </div>
                                        <span className="text-[10px] uppercase tracking-widest font-bold text-red-400 shrink-0">
                                            Unsave
                                        </span>
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={handleSaveCurrent}
                                        className={`w-full flex items-center justify-between gap-2 text-left p-2 rounded-lg hover:bg-white/5 transition-colors ${accent.text}`}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-0.5">
                                                Save current
                                            </div>
                                            <div className="text-sm font-medium text-white truncate">{currentName}</div>
                                        </div>
                                        <StarIcon className="w-4 h-4 shrink-0" filled={false} />
                                    </button>
                                )
                            ) : (
                                <div className="text-xs text-gray-500 italic px-1 py-2">
                                    Enter or pick a {target === 'origin' ? 'departure' : 'destination'} above to save it
                                    here.
                                </div>
                            )}
                        </div>

                        {/* Saved locations list */}
                        <div role="none" className="max-h-72 overflow-y-auto">
                            {savedList.length === 0 ? (
                                <div className="text-xs text-gray-500 italic p-4 text-center">
                                    No saved locations yet. Save a place from the route planner or your weather page to
                                    recall it here later.
                                </div>
                            ) : (
                                <div role="none" className="py-1">
                                    <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold px-3 pt-2 pb-1">
                                        Saved
                                    </div>
                                    {savedList.map((loc) => (
                                        <div
                                            key={loc.name}
                                            role="none"
                                            className="flex items-center gap-2 px-3 hover:bg-white/5 transition-colors"
                                        >
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => handlePick(loc.name)}
                                                className="flex items-center gap-2 flex-1 min-w-0 text-left py-2"
                                            >
                                                <MapPinIcon className={`w-4 h-4 shrink-0 ${accent.text}`} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-sm font-medium text-white truncate">
                                                        {loc.name}
                                                    </div>
                                                    {typeof loc.lat === 'number' && typeof loc.lon === 'number' && (
                                                        <div className="text-[10px] font-mono text-sky-300/60 mt-0.5">
                                                            {loc.lat.toFixed(2)}°{loc.lat >= 0 ? 'N' : 'S'} ·{' '}
                                                            {loc.lon.toFixed(2)}°{loc.lon >= 0 ? 'E' : 'W'}
                                                        </div>
                                                    )}
                                                </div>
                                            </button>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => handleRemove(loc.name)}
                                                className="p-2 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                                                aria-label={`Remove ${loc.name}`}
                                            >
                                                <TrashIcon className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>,
                    document.body,
                )}
        </>
    );
};

// Inline star icon — matches the visual weight of the existing
// MapIcon / CrosshairIcon in the right-edge button group. Using a
// local SVG instead of pulling another Icons.tsx export so the
// fill/outline switch is trivial.
const StarIcon: React.FC<{ className?: string; filled: boolean }> = ({ className, filled }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
);
