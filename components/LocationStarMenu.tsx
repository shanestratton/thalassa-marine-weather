/**
 * LocationStarMenu — the ★ in the dashboard location box.
 *
 * Replaces the old "tap ★ = toggle favourite" behaviour with a small
 * Locations flyout (Shane, 2026-06-16): tap the star → a portaled
 * popover listing, top to bottom,
 *   ⌂ Home port    — the user's designated home, pinned first;
 *   ✛ Current Location — jump back to live GPS-follow;
 *   📍 saved spots — each tappable, with set-as-home + remove;
 *   ★ Save this spot as “…” — footer that saves the current location.
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
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { panePopoverStyle, usePanePortalTarget } from '../context/PanePortalContext';
import { ConfirmDialog } from './ui/ConfirmDialog';

import { CheckIcon, CrosshairIcon, MapPinIcon, StarIcon, TrashIcon } from './Icons';
import { HomeIcon } from './icons/GlassGlyphs';
import { calculateDistanceKm } from '../utils/math';
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
import { useMenuNavigation } from '../hooks/useMenuNavigation';
import { getWeatherFollowTarget, setWeatherFollowTarget, type WeatherFollowTarget } from '../services/weatherPosition';

/** The boat, drawn as the ℹ panel's GPS glyph draws her. */
const BoatIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M11 4v11" />
        <path d="M11 5l6 9h-6z" fill="currentColor" fillOpacity={0.35} />
        <path d="M3 17h17l-2.5 3.5H5.5z" />
    </svg>
);

/** About 340 pt, held inside the 16 pt gutters: at 264 'Gladstone, QLD'
 *  wrapped to two lines beside its captioned Set home and Remove (UX
 *  scorecard run 10). */
const POPOVER_WIDTH = 340;
const POPOVER_GUTTER = 16;
/** Never narrower than it was. */
const POPOVER_WIDTH_FLOOR = 264;
const POPOVER_GAP = 8;
/** A saved place within this of the place on screen IS the place on screen. */
const SAME_PLACE_KM = 1;

/** 'Gladstone, QLD' → 'gladstone': the place name before any region. */
const baseName = (name: string) => name.split(',')[0].trim().toLowerCase();

export const LocationStarMenu: React.FC = () => {
    const portalTarget = usePanePortalTarget();
    const { settings, updateSettings } = useSettings();
    const { weatherData, selectLocation, positionSource } = useWeather();

    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const popoverRef = useMenuNavigation<HTMLDivElement>(open, {
        triggerRef: buttonRef,
        onClose: () => setOpen(false),
    });
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    const saved = useMemo(
        () => hydrateSavedLocations(settings.savedLocations, settings.savedLocationCoords),
        [settings.savedLocations, settings.savedLocationCoords],
    );

    const inGpsMode = settings.defaultLocation === 'Current Location';
    // What 'Current Location' follows — the phone by default, the boat when her
    // row below is picked (Shane 2026-09-08: "the weather should always be the
    // punters location, BUT in the saved locations, there should be one that
    // has the vessel name as a special saved location"). Read when the menu
    // opens so the tick sits on the right row.
    const [followTarget, setFollowTargetState] = useState<WeatherFollowTarget>(() => getWeatherFollowTarget());
    useEffect(() => {
        if (!open) return;
        setFollowTargetState(getWeatherFollowTarget());
    }, [open]);
    const vesselName = settings.vessel?.name?.trim() || 'Vessel location';
    // The ticked receiver has no fix and the Glass shows the forecast it
    // kept for her last location (App's 'Last · …' title). The tick still
    // marks the pick, but it no longer implies a live follow (UX scorecard
    // run 8): it turns amber, the held colour of the header's retry glyph,
    // and the row's name says why. Amber alone told a sighted skipper
    // nothing (run 9), so the row also carries the fix state in the one
    // truth's words (gpsFixState's 'No live fix · last position'). It names
    // no GPS source: the ℹ panel stays the one place for that (Shane,
    // 2026-09-08).
    const showingLastLocation = Boolean(
        positionSource?.status === 'unavailable' && positionSource.retainedWeather && weatherData,
    );
    const phoneTicked = inGpsMode && followTarget === 'phone';
    const boatTicked = inGpsMode && followTarget === 'boat';
    const lastLocationFor = showingLastLocation ? (positionSource?.target ?? followTarget) : null;
    // Spoken as part of the row's name, set as a label: an sr-only span in the
    // row is absolutely positioned, so it read as a separate block and the
    // name came out 'Current Location , GPS unavailable…' (UX scorecard run 9).
    const lastLocationSpoken = ', GPS unavailable, showing last location';
    // Seen, not read twice: the name already speaks the note above.
    const lastLocationCaption = (
        <span aria-hidden="true" className="block text-xs leading-4 font-medium text-amber-400">
            No live fix · last position
        </span>
    );
    const currentName = weatherData?.locationName ?? '';
    const isRealCurrent = currentName.length > 0 && currentName !== 'Current Location';
    // The saved entry for the place on screen. Matched by position (within
    // about a kilometre) before name: the Glass titles a pick by the
    // geocoder's 'Gladstone' while the saved entry reads 'Gladstone, QLD', and
    // a name-only match offered to save it again right under its own row
    // (UX scorecard run 6). Name is the fallback for entries saved without
    // coordinates; for those the region after a comma is ignored, so a typed
    // 'Gladstone, QLD' is the Glass's 'Gladstone' (UX scorecard run 7).
    const currentLat = weatherData?.coordinates?.lat;
    const currentLon = weatherData?.coordinates?.lon;
    const shownSaved = useMemo(() => {
        if (!isRealCurrent) return undefined;
        if (typeof currentLat === 'number' && typeof currentLon === 'number') {
            const near = saved.find(
                (s) =>
                    typeof s.lat === 'number' &&
                    typeof s.lon === 'number' &&
                    calculateDistanceKm(currentLat, currentLon, s.lat, s.lon) <= SAME_PLACE_KM,
            );
            if (near) return near;
        }
        const exact = saved.find((s) => s.name.toLowerCase() === currentName.toLowerCase());
        if (exact) return exact;
        return saved.find(
            (s) => typeof s.lat !== 'number' && typeof s.lon !== 'number' && baseName(s.name) === baseName(currentName),
        );
    }, [isRealCurrent, currentLat, currentLon, currentName, saved]);
    const currentSaved = !!shownSaved;
    // The tick for a saved row: only while the Glass is on that pick, not
    // while it follows a GPS that happens to be near it.
    const isShownRow = (name: string) => !inGpsMode && shownSaved?.name === name;

    // Home port is only valid while it still exists in savedLocations.
    const homePort =
        settings.homePort && saved.some((s) => s.name === settings.homePort) ? settings.homePort : undefined;
    const homePortLoc = homePort ? saved.find((s) => s.name === homePort) : undefined;
    const otherSaved = saved.filter((s) => s.name !== homePort);

    // Removing a hand-saved place asks first (Shane 2026-09-26: the small state items were my call).
    const [pendingRemove, setPendingRemove] = useState<string | null>(null);
    const pendingRemoveRef = useRef<string | null>(null);
    pendingRemoveRef.current = pendingRemove;

    // Anchor the popover to the button's viewport rect; re-measure on open
    // and resize. Any scroll outside the flyout closes it instead: a day or
    // hour swipe re-measured it and left it open over a different day's grid
    // (UX scorecard run 7). Scrolling its own list, or the remove confirm,
    // keeps it open.
    useLayoutEffect(() => {
        if (!open || !portalTarget) return;
        const measure = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) setAnchorRect(rect);
        };
        const onScroll = (event: Event) => {
            const target = event.target;
            if (target instanceof Node && popoverRef.current?.contains(target)) return;
            if (pendingRemoveRef.current !== null) return;
            setOpen(false);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(portalTarget);
        if (buttonRef.current) observer.observe(buttonRef.current);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', measure);
        };
    }, [open, portalTarget, popoverRef]);

    // Close on outside-click (check both button + popover since
    // the popover lives in a portal). The dim behind the flyout closes it on
    // its own click, so that tap is swallowed rather than landing on the
    // grid cell underneath.
    const backdropRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (backdropRef.current?.contains(t)) return;
            if (!buttonRef.current?.contains(t) && !popoverRef.current?.contains(t)) setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('touchstart', onClick);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('touchstart', onClick);
        };
    }, [open, popoverRef]);

    const closeAndRestore = () => {
        setOpen(false);
        requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
    };

    /** The vessel's row: the weather goes to her and stays with her. */
    const goToBoat = () => {
        triggerHaptic('light');
        setWeatherFollowTarget('boat');
        setFollowTargetState('boat');
        closeAndRestore();
        // Register intent before any GPS await. The context owns resolution,
        // unavailable-state UI and cancellation by a subsequent selection.
        void selectLocation('Current Location');
    };

    const goTo = (loc: SavedLocation | 'current') => {
        triggerHaptic('light');
        closeAndRestore();
        if (loc === 'current') {
            // Back to the punter: 'Current Location' follows the phone again.
            setWeatherFollowTarget('phone');
            setFollowTargetState('phone');
            void selectLocation('Current Location', undefined, { requestPhonePermission: true });
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
        closeAndRestore();
    };

    const saveCurrent = () => {
        if (!isRealCurrent) return;
        triggerHaptic('light');
        const c = weatherData?.coordinates;
        const planner = toPlannerString({ name: currentName, lat: c?.lat, lon: c?.lon });
        const patch = buildSaveLocationPatch(settings.savedLocations, settings.savedLocationCoords, planner);
        if (patch) updateSettings(patch);
        closeAndRestore();
    };

    // Anchor to the button's right edge, as wide as fits with its left edge
    // at least the 16 pt gutter in from the pane's.
    const popoverStyle: React.CSSProperties = (() => {
        if (!anchorRect || !portalTarget) return { display: 'none' };
        const paneLeft = portalTarget.hasAttribute('data-pane-portal') ? portalTarget.getBoundingClientRect().left : 0;
        const width = Math.max(
            POPOVER_WIDTH_FLOOR,
            Math.min(POPOVER_WIDTH, Math.round(anchorRect.right - paneLeft - POPOVER_GUTTER)),
        );
        return panePopoverStyle(portalTarget, anchorRect, width, POPOVER_GAP);
    })();

    // min-h-[44px]: at 393 pt the one-line rows measured 43 pt (review, batch 11).
    const rowBase =
        'flex min-h-[44px] items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/5 active:bg-white/10';
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
                aria-haspopup="menu"
                aria-controls={open ? menuId : undefined}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-300 transition-colors hover:bg-white/10 hover:text-yellow-400"
            >
                <StarIcon className={`w-4 h-4 ${starActive ? 'text-yellow-400' : ''}`} filled={starActive} />
            </button>

            {open &&
                portalTarget &&
                createPortal(
                    <>
                        {/* A 35 % dim behind the flyout: without it the rows sat
                        straight on the grid and cut its labels in half (UX
                        scorecard run 6). Tapping it closes the flyout, and so
                        does starting to swipe the Glass behind it. */}
                        <div
                            ref={backdropRef}
                            aria-hidden="true"
                            className="fixed inset-0 z-9998 bg-black/35 animate-in fade-in duration-150"
                            onClick={() => setOpen(false)}
                            onTouchMove={() => setOpen(false)}
                            onWheel={() => setOpen(false)}
                        />
                        <div
                            id={menuId}
                            ref={popoverRef}
                            style={popoverStyle}
                            role="menu"
                            aria-label="Saved locations"
                            tabIndex={-1}
                            // Opaque (thalassa-popover-solid): at /95 + blur the Glass's
                            // forecast text ghosted under the rows (UX scorecard run 5).
                            // One step lighter than the cards under it, with a lit edge
                            // and a deep drop shadow: on the cards' own navy its edge
                            // dissolved into the chips beside it (UX scorecard run 9).
                            className="thalassa-popover-solid rounded-2xl bg-slate-800 border border-white/15 shadow-[0_18px_48px_rgba(0,0,0,0.7),0_2px_8px_rgba(0,0,0,0.5)] [.display-light_&]:shadow-[0_12px_32px_rgba(15,23,42,0.22)] overflow-hidden"
                        >
                            <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-gray-400 border-b border-white/10">
                                Locations
                            </div>

                            <div role="none" className="max-h-[55vh] overflow-y-auto py-1">
                                {/* Home port — pinned first */}
                                {homePortLoc && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => goTo(homePortLoc)}
                                        aria-current={homePort && isShownRow(homePort) ? 'location' : undefined}
                                        className={`${rowBase} w-full`}
                                    >
                                        {/* Neutral ink: amber is the no-fix warning's
                                            alone in this menu (UX scorecard run 10). */}
                                        <HomeIcon className="w-4 h-4 text-sky-300 shrink-0" />
                                        <span className="flex-1 min-w-0 font-semibold text-white line-clamp-2 wrap-break-word">
                                            {homePort}
                                        </span>
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                                            Home
                                        </span>
                                        {homePort && isShownRow(homePort) && (
                                            <CheckIcon className="w-4 h-4 text-sky-400 shrink-0" />
                                        )}
                                    </button>
                                )}

                                {/* The boat — a special saved location named after her
                                (2026-09-08). Moves the weather to her position — her
                                receivers, the Pi, her cloud row, or her last fix — and
                                keeps it there until Current Location is picked again. */}
                                {vesselName && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={goToBoat}
                                        data-testid="location-star-vessel"
                                        // The tick, for a screen reader too (UX scorecard run 8).
                                        aria-current={boatTicked ? 'location' : undefined}
                                        aria-label={
                                            boatTicked && lastLocationFor === 'boat'
                                                ? `${vesselName} Boat${lastLocationSpoken}`
                                                : undefined
                                        }
                                        className={`${rowBase} w-full`}
                                    >
                                        <BoatIcon className="w-4 h-4 text-emerald-400 shrink-0" />
                                        <span className="flex-1 min-w-0">
                                            <span className="block font-semibold text-emerald-100 line-clamp-2 wrap-break-word">
                                                {vesselName}
                                            </span>
                                            {boatTicked && lastLocationFor === 'boat' && lastLocationCaption}
                                        </span>
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400/70">
                                            Boat
                                        </span>
                                        {boatTicked && (
                                            <CheckIcon
                                                className={`w-4 h-4 shrink-0 ${lastLocationFor === 'boat' ? 'text-amber-400' : 'text-emerald-400'}`}
                                            />
                                        )}
                                    </button>
                                )}
                                {/* Current Location — back to live GPS-follow of the phone */}
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => goTo('current')}
                                    aria-current={phoneTicked ? 'location' : undefined}
                                    aria-label={
                                        phoneTicked && lastLocationFor === 'phone'
                                            ? `Current Location${lastLocationSpoken}`
                                            : undefined
                                    }
                                    className={`${rowBase} w-full`}
                                >
                                    <CrosshairIcon className="w-4 h-4 text-sky-400 shrink-0" />
                                    <span className="flex-1 min-w-0">
                                        <span className="block font-medium text-white truncate">Current Location</span>
                                        {phoneTicked && lastLocationFor === 'phone' && lastLocationCaption}
                                    </span>
                                    {phoneTicked && (
                                        <CheckIcon
                                            className={`w-4 h-4 shrink-0 ${lastLocationFor === 'phone' ? 'text-amber-400' : 'text-sky-400'}`}
                                        />
                                    )}
                                </button>

                                {otherSaved.length > 0 && (
                                    <div role="separator" className="my-1 mx-3 h-px bg-white/10" />
                                )}

                                {/* Saved spots */}
                                {/* The row the Glass is showing carries a tick and a
                                    faint wash (UX scorecard run 7). The home and
                                    remove icons have one-word captions, since a
                                    bare house read as decoration. */}
                                {otherSaved.map((loc) => (
                                    <div
                                        key={loc.name}
                                        role="none"
                                        // pr-2: 'Remove' ended 2 pt from the flyout's edge (UX scorecard run 8).
                                        className={`flex items-center pr-2 ${isShownRow(loc.name) ? 'bg-sky-500/10' : ''}`}
                                    >
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => goTo(loc)}
                                            aria-current={isShownRow(loc.name) ? 'location' : undefined}
                                            className={`${rowBase} flex-1 min-w-0`}
                                        >
                                            <MapPinIcon className="w-4 h-4 text-gray-400 shrink-0" />
                                            {/* Two lines before an ellipsis: cut at one, 'Gladstone, QLD'
                                                read 'Gladstone, …' beside the captioned actions (run 9). */}
                                            <span className="flex-1 min-w-0 text-white leading-snug line-clamp-2 wrap-break-word">
                                                {loc.name}
                                            </span>
                                            {isShownRow(loc.name) && (
                                                <CheckIcon className="w-4 h-4 text-sky-400 shrink-0" />
                                            )}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => setHome(loc.name)}
                                            // The name starts with the visible caption, 'Set home'.
                                            // A bare 'Home' beside a place that is not home read
                                            // as its status, not the action (UX scorecard run 8).
                                            aria-label={`Set home port to ${loc.name}`}
                                            title="Set as home port"
                                            className="min-w-[44px] min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-gray-400 hover:text-sky-300 transition-colors shrink-0"
                                        >
                                            <HomeIcon className="w-4 h-4" />
                                            <span
                                                aria-hidden="true"
                                                className="text-[12px] leading-none whitespace-nowrap"
                                            >
                                                Set home
                                            </span>
                                        </button>
                                        {/* 4 pt and a hairline each side: butted together, the two
                                            captions read 'Set home Remove' (UX scorecard run 9). */}
                                        <span
                                            aria-hidden="true"
                                            className="mx-1 h-6 w-px shrink-0 bg-white/15 [.display-light_&]:bg-slate-300!"
                                        />
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => setPendingRemove(loc.name)}
                                            aria-label={`Remove ${loc.name}`}
                                            title="Remove"
                                            className="min-w-[48px] min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-gray-400 hover:text-red-400 transition-colors shrink-0"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                            <span aria-hidden="true" className="text-[12px] leading-none">
                                                Remove
                                            </span>
                                        </button>
                                    </div>
                                ))}

                                <ConfirmDialog
                                    isOpen={pendingRemove !== null}
                                    title="Remove saved place?"
                                    message={`${pendingRemove ?? ''} will be removed from your saved places.`}
                                    confirmLabel="Remove"
                                    cancelLabel="Keep"
                                    destructive
                                    onConfirm={() => {
                                        if (pendingRemove) removeSaved(pendingRemove);
                                        setPendingRemove(null);
                                    }}
                                    onCancel={() => setPendingRemove(null)}
                                />
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
                                    role="menuitem"
                                    onClick={saveCurrent}
                                    // The sky action colour, not amber: amber is the
                                    // no-fix warning's in this menu (UX scorecard run 10).
                                    className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2.5 border-t border-white/10 text-sky-300 hover:bg-white/5 transition-colors"
                                >
                                    <StarIcon className="w-4 h-4 shrink-0" />
                                    {/* 'Save “Gladstone”' under a saved 'Gladstone, QLD'
                                        read as a duplicate; this says it is the spot
                                        on screen that gets saved (UX scorecard run 7). */}
                                    <span className="min-w-0 text-left font-semibold leading-snug wrap-break-word">
                                        Save this spot as “{currentName}”
                                    </span>
                                </button>
                            )}
                            {isRealCurrent && currentSaved && (
                                <div className="flex items-center gap-1.5 px-3 py-2 border-t border-white/10 text-[11px] text-gray-400">
                                    <span className="truncate">{shownSaved?.name ?? currentName} is saved</span>
                                    <CheckIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                </div>
                            )}
                        </div>
                    </>,
                    portalTarget,
                )}
        </>
    );
};
