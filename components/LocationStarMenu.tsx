/**
 * LocationStarMenu — the ★ in the dashboard location box.
 *
 * Replaces the old "tap ★ = toggle favourite" behaviour with a small
 * Locations flyout (Shane, 2026-06-16): tap the star → a portaled
 * popover listing, top to bottom,
 *   ⚓ Home port    — the user's designated home, pinned first;
 *   ✛ Current Location — jump back to live GPS-follow;
 *   📍 saved spots — each tappable, with set-as-home + remove;
 *   ★ Save “…”     — footer that saves the current location.
 *
 * Why a separate home-port concept: useAppController effect 1b keeps
 * `settings.defaultLocation` as 'Current Location' so every open follows
 * GPS. Home port therefore can't live in defaultLocation any more — it's
 * `settings.homePort` (a name in `savedLocations`), surfaced here as a
 * one-tap PICK, never the open default.
 *
 * Picking a named port puts the app in 'selected' mode for the session;
 * the next open re-centres on the live position (1b). Picking Current
 * Location returns to GPS-follow immediately.
 *
 * Portal mechanics + iOS gotchas are lifted from SavedLocationsPicker:
 * render through createPortal into <body> with position:fixed anchored
 * to the button rect (escapes the header's nested overflow contexts);
 * no nested <button>s (WKWebView rewrites them and breaks the handler);
 * action icons are always-visible (iOS has no hover).
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AnchorIcon, CheckIcon, CrosshairIcon, MapPinIcon, StarIcon, TrashIcon } from './Icons';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
import {
    buildRemoveLocationPatch,
    buildSaveLocationPatch,
    hydrateSavedLocations,
    toPlannerString,
    type SavedLocation,
} from '../utils/savedLocations';
import { triggerHaptic } from '../utils/system';

const POPOVER_WIDTH = 264;
const POPOVER_GAP = 8;

export const LocationStarMenu: React.FC = () => {
    const { settings, updateSettings } = useSettings();
    const { weatherData, selectLocation } = useWeather();

    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    const saved = useMemo(
        () => hydrateSavedLocations(settings.savedLocations, settings.savedLocationCoords),
        [settings.savedLocations, settings.savedLocationCoords],
    );

    const inGpsMode = settings.defaultLocation === 'Current Location';
    const currentName = weatherData?.locationName ?? '';
    const isRealCurrent = currentName.length > 0 && currentName !== 'Current Location';
    const currentSaved = isRealCurrent && saved.some((s) => s.name.toLowerCase() === currentName.toLowerCase());

    // Home port is only valid while it still exists in savedLocations.
    const homePort =
        settings.homePort && saved.some((s) => s.name === settings.homePort) ? settings.homePort : undefined;
    const homePortLoc = homePort ? saved.find((s) => s.name === homePort) : undefined;
    const otherSaved = saved.filter((s) => s.name !== homePort);

    // Anchor the popover to the button's viewport rect; re-measure on
    // open + scroll/resize so it follows the header.
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

    // Close on outside-click / Escape (check both button + popover since
    // the popover lives in a portal).
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (!buttonRef.current?.contains(t) && !popoverRef.current?.contains(t)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('touchstart', onClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('touchstart', onClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const goTo = (loc: SavedLocation | 'current') => {
        triggerHaptic('light');
        setOpen(false);
        if (loc === 'current') {
            void selectLocation('Current Location');
            return;
        }
        const coords =
            typeof loc.lat === 'number' && typeof loc.lon === 'number' ? { lat: loc.lat, lon: loc.lon } : undefined;
        void selectLocation(loc.name, coords);
    };

    const setHome = (name: string) => {
        triggerHaptic('light');
        updateSettings({ homePort: name });
    };

    const removeSaved = (name: string) => {
        triggerHaptic('light');
        const patch = buildRemoveLocationPatch(settings.savedLocations, settings.savedLocationCoords, name);
        // Removing the home port clears the designation too.
        updateSettings(settings.homePort === name ? { ...patch, homePort: undefined } : patch);
    };

    const saveCurrent = () => {
        if (!isRealCurrent) return;
        triggerHaptic('light');
        const c = weatherData?.coordinates;
        const planner = toPlannerString({ name: currentName, lat: c?.lat, lon: c?.lon });
        const patch = buildSaveLocationPatch(settings.savedLocations, settings.savedLocationCoords, planner);
        if (patch) updateSettings(patch);
    };

    // Anchor to the button's right edge; clamp 8px from each viewport edge.
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

    const rowBase =
        'flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/5 active:bg-white/10';
    // Star reads "active" when there's a home port or the current spot is saved.
    const starActive = !!homePort || currentSaved;

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => {
                    triggerHaptic('light');
                    setOpen((v) => !v);
                }}
                aria-label="Saved locations"
                aria-expanded={open}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-300 transition-colors hover:bg-white/10 hover:text-yellow-400"
            >
                <StarIcon className={`w-4 h-4 ${starActive ? 'text-yellow-400' : ''}`} filled={starActive} />
            </button>

            {open &&
                anchorRect &&
                createPortal(
                    <div
                        ref={popoverRef}
                        style={popoverStyle}
                        role="menu"
                        className="rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/10 shadow-2xl overflow-hidden"
                    >
                        <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b border-white/10">
                            Locations
                        </div>

                        <div className="max-h-[55vh] overflow-y-auto py-1">
                            {/* Home port — pinned first */}
                            {homePortLoc && (
                                <button type="button" onClick={() => goTo(homePortLoc)} className={`${rowBase} w-full`}>
                                    <AnchorIcon className="w-4 h-4 text-amber-400 shrink-0" />
                                    <span className="flex-1 font-semibold text-amber-100 truncate">{homePort}</span>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400/70">
                                        Home
                                    </span>
                                </button>
                            )}

                            {/* Current Location — back to live GPS-follow */}
                            <button type="button" onClick={() => goTo('current')} className={`${rowBase} w-full`}>
                                <CrosshairIcon className="w-4 h-4 text-sky-400 shrink-0" />
                                <span className="flex-1 font-medium text-white truncate">Current Location</span>
                                {inGpsMode && <CheckIcon className="w-4 h-4 text-sky-400 shrink-0" />}
                            </button>

                            {otherSaved.length > 0 && <div className="my-1 mx-3 h-px bg-white/10" />}

                            {/* Saved spots */}
                            {otherSaved.map((loc) => (
                                <div key={loc.name} className="flex items-center">
                                    <button
                                        type="button"
                                        onClick={() => goTo(loc)}
                                        className={`${rowBase} flex-1 min-w-0`}
                                    >
                                        <MapPinIcon className="w-4 h-4 text-gray-400 shrink-0" />
                                        <span className="flex-1 text-white truncate">{loc.name}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setHome(loc.name)}
                                        aria-label={`Set ${loc.name} as home port`}
                                        title="Set as home port"
                                        className="p-2 text-gray-500 hover:text-amber-400 transition-colors shrink-0"
                                    >
                                        <AnchorIcon className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => removeSaved(loc.name)}
                                        aria-label={`Remove ${loc.name}`}
                                        title="Remove"
                                        className="p-2 pr-3 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                                    >
                                        <TrashIcon className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}

                            {!homePortLoc && otherSaved.length === 0 && (
                                <div className="px-3 py-3 text-xs text-gray-500">
                                    No saved locations yet — save one below, then set it as your home port.
                                </div>
                            )}
                        </div>

                        {/* Save / saved-state footer for the current location */}
                        {isRealCurrent && !currentSaved && (
                            <button
                                type="button"
                                onClick={saveCurrent}
                                className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-white/10 text-amber-300 hover:bg-white/5 transition-colors"
                            >
                                <StarIcon className="w-4 h-4 shrink-0" />
                                <span className="font-semibold truncate">Save “{currentName}”</span>
                            </button>
                        )}
                        {isRealCurrent && currentSaved && (
                            <div className="flex items-center gap-1.5 px-3 py-2 border-t border-white/10 text-[11px] text-gray-500">
                                <CheckIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                <span className="truncate">{currentName} is saved</span>
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </>
    );
};
