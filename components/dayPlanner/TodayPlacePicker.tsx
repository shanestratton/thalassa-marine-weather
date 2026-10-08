import React, { useEffect, useRef, useState } from 'react';
import type { BoatFix } from '../../services/boatPositionChain';
import { GpsService } from '../../services/GpsService';
import { plannerFixAge } from '../../services/plannerVesselPosition';
import { parseLocation } from '../../services/weather/api/geocoding';
import { LocationStore } from '../../stores/LocationStore';
import type { UserSettings } from '../../types/settings';
import { parseCoordinateString } from '../../utils/coordParse';
import { extractCoords, extractDisplayName, hydrateSavedLocations } from '../../utils/savedLocations';
import type { LatLon } from '../../services/dayPlanner/places';
import { TodayModal } from './TodayModal';

/** Where Plan Your Day plans from. */
export type PlanStart =
    | { kind: 'boat'; lat: number; lon: number; fix: BoatFix }
    | { kind: 'phone'; lat: number; lon: number }
    | { kind: 'saved'; lat: number; lon: number; name: string; home?: boolean }
    | { kind: 'typed'; lat: number; lon: number; name: string | null };

export interface SavedPlanPlace extends LatLon {
    name: string;
    home: boolean;
}

/** Swapped only by fixtures and tests. */
export interface PlacePickerIO {
    readPhone?: () => Promise<LatLon | null>;
    geocode?: (text: string, near: LatLon | null) => Promise<(LatLon & { name: string }) | null>;
}

const valid = (p: Partial<LatLon> | null | undefined): p is LatLon =>
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180;

/** The home port and the saved places that have coordinates, home port first. */
export function savedPlanPlaces(
    settings: Pick<UserSettings, 'homePort' | 'savedLocations' | 'savedLocationCoords'>,
): SavedPlanPlace[] {
    const out: SavedPlanPlace[] = [];
    const home = settings.homePort?.trim();
    const homeName = home ? extractDisplayName(home) : '';
    if (home) {
        const at =
            settings.savedLocationCoords?.[home] ?? settings.savedLocationCoords?.[homeName] ?? extractCoords(home);
        if (valid(at)) out.push({ lat: at.lat, lon: at.lon, name: homeName, home: true });
    }
    for (const place of hydrateSavedLocations(settings.savedLocations, settings.savedLocationCoords)) {
        const name = extractDisplayName(place.name);
        const at = valid(place) ? place : extractCoords(place.name);
        if (!valid(at) || !name || name === homeName) continue;
        out.push({ lat: at.lat, lon: at.lon, name, home: false });
    }
    return out;
}

/**
 * This phone's position: a fix under five minutes old, else the app's last
 * GPS fix. Asked only on her tap, through the foreground-only request (it
 * asks for coarse permission then and never starts the background engine:
 * tests/ForegroundLocationBoundary.test.ts).
 */
export async function readPhonePosition(): Promise<LatLon | null> {
    const fix = await GpsService.requestCurrentForegroundPosition({ staleLimitMs: 5 * 60_000, timeoutSec: 10 }).catch(
        () => null,
    );
    if (fix && valid({ lat: fix.latitude, lon: fix.longitude })) return { lat: fix.latitude, lon: fix.longitude };
    const last = LocationStore.getState();
    return last.source === 'gps' && valid(last) && Date.now() - last.timestamp < 6 * 3_600_000
        ? { lat: last.lat, lon: last.lon }
        : null;
}

async function geocodePlace(text: string, near: LatLon | null): Promise<(LatLon & { name: string }) | null> {
    const found = await parseLocation(text, near ?? undefined);
    if (!found || !valid(found) || (found.lat === 0 && found.lon === 0)) return null;
    return { lat: found.lat, lon: found.lon, name: found.name || text };
}

/**
 * Plan Your Day: "Plan from" (build 124). Her boat (bus, Pi, then her cloud
 * report), this phone, the home port and saved places, or a typed place or
 * position. A nested centred modal; the list may scroll.
 */
export function TodayPlacePicker({
    boat,
    signedIn,
    nowMs,
    current,
    currentName,
    saved,
    focus,
    io,
    onStart,
    onClose,
}: {
    boat: BoatFix | null;
    signedIn: boolean;
    nowMs: number;
    current: PlanStart | null;
    currentName: string | null;
    saved: readonly SavedPlanPlace[];
    focus: 'list' | 'type';
    io: PlacePickerIO;
    onStart: (start: PlanStart) => void;
    onClose: () => void;
}) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState<'phone' | 'typed' | null>(null);
    const [message, setMessage] = useState('');
    const fieldRef = useRef<HTMLInputElement>(null);
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        if (focus === 'type') fieldRef.current?.focus();
        return () => {
            live.current = false;
        };
    }, [focus]);

    const boatName = current?.kind === 'boat' && currentName ? currentName : null;
    const boatLine = boat ? ['Boat', boatName, plannerFixAge(boat, nowMs)].filter(Boolean).join(' · ') : 'Boat';
    const boatNote = boat
        ? null
        : signedIn
          ? 'No position from the boat in the last 24 h'
          : 'Sign in to see her position';

    const phone = async () => {
        setBusy('phone');
        setMessage('');
        const at = await (io.readPhone ?? readPhonePosition)().catch(() => null);
        if (!live.current) return;
        setBusy(null);
        if (at) onStart({ kind: 'phone', lat: at.lat, lon: at.lon });
        else setMessage('This phone has no position. Allow location for Thalassa, or type a place.');
    };

    const typed = async (event: React.FormEvent) => {
        event.preventDefault();
        const query = text.trim();
        if (!query) return;
        const coords = parseCoordinateString(query);
        if (coords && valid(coords)) {
            onStart({ kind: 'typed', lat: coords.lat, lon: coords.lon, name: null });
            return;
        }
        setBusy('typed');
        setMessage('');
        const near = current ? { lat: current.lat, lon: current.lon } : null;
        const found = await (io.geocode ?? geocodePlace)(query, near).catch(() => null);
        if (!live.current) return;
        setBusy(null);
        if (found) onStart({ kind: 'typed', lat: found.lat, lon: found.lon, name: found.name });
        else setMessage(`Couldn't find "${query}". Try a nearby town, or lat, lon.`);
    };

    return (
        <TodayModal title="Plan from" onClose={onClose} className="today-list-card">
            <ul className="today-options">
                <li>
                    <button
                        type="button"
                        className="today-option"
                        disabled={!boat}
                        aria-describedby={boatNote ? 'today-boat-note' : undefined}
                        onClick={() =>
                            boat && onStart({ kind: 'boat', lat: boat.latitude, lon: boat.longitude, fix: boat })
                        }
                    >
                        <span aria-hidden="true">⛵</span> {boatLine}
                    </button>
                    {boatNote && (
                        <p id="today-boat-note" className="today-option-note">
                            {boatNote}
                        </p>
                    )}
                </li>
                <li>
                    <button
                        type="button"
                        className="today-option"
                        disabled={busy !== null}
                        onClick={() => void phone()}
                    >
                        <span aria-hidden="true">📱</span> {busy === 'phone' ? 'Finding this phone…' : 'This phone'}
                    </button>
                </li>
                {saved.map((place) => (
                    <li key={`${place.name}:${place.lat}:${place.lon}`}>
                        <button
                            type="button"
                            className="today-option"
                            onClick={() =>
                                onStart({
                                    kind: 'saved',
                                    lat: place.lat,
                                    lon: place.lon,
                                    name: place.name,
                                    home: place.home,
                                })
                            }
                        >
                            {place.home ? `Home port · ${place.name}` : place.name}
                        </button>
                    </li>
                ))}
            </ul>
            <form className="today-type" onSubmit={(e) => void typed(e)}>
                <input
                    ref={fieldRef}
                    type="text"
                    enterKeyHint="go"
                    autoComplete="off"
                    aria-label="Type a place or lat, lon"
                    placeholder="Type a place or lat, lon"
                    value={text}
                    maxLength={120}
                    onChange={(e) => setText(e.target.value)}
                />
                <button type="submit" className="today-button" disabled={busy !== null || !text.trim()}>
                    {busy === 'typed' ? '…' : 'Go'}
                </button>
            </form>
            {message && (
                <p role="status" className="today-option-note">
                    {message}
                </p>
            )}
        </TodayModal>
    );
}
