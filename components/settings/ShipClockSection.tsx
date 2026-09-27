/**
 * ShipClockSection — the ship's bell clock's switches, in Settings → Preferences.
 *
 * Moved out of the Instrument Panel's Bells page on 2026-09-09 (Shane: "get rid
 * of the bells page"; and "i want to move most toggles there"). The clock and
 * the striking stay in the panel; this is where they are set. Same rules as
 * before: the bells are OFF by default and remembered; Test does not depend on
 * the toggle (hearing the bell is how a skipper decides) and does the iOS
 * audio unlock, because only a real tap may resume a suspended Web Audio
 * context; "Ship's position" follows the boat's zone with the phone as the
 * fallback until she reports.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Row, Section, Toggle } from './SettingsPrimitives';
import { ShipsBellChime } from '../../services/ShipsBellChime';
import { bellsAt, bellsSpoken } from '../../utils/shipsBells';
import { clockInZone, deviceTimeZone, displayZoneId, listTimeZones, zoneDisplayName } from '../../utils/timeZones';
import { useWeatherOptional } from '../../context/WeatherContext';
import { toast } from '../Toast';
import {
    SHIP_CLOCK_PREFS_EVENT,
    SHIP_ZONE_AUTO,
    readShipClockPrefs,
    writeShipClockPrefs,
    type ShipClockPrefs,
} from '../../services/shipClockPrefs';

/** "GMT+10" → "UTC+10" for a zone right now, or '' where Intl cannot say.
 *  Offsets move with daylight saving, so this is read, never computed. */
function utcOffsetLabel(timeZone: string, when: Date): string {
    try {
        const name =
            new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' })
                .formatToParts(when)
                .find((p) => p.type === 'timeZoneName')?.value ?? '';
        return name.replace(/^GMT/, 'UTC').replace(/^UTC$/, 'UTC+0');
    } catch {
        return '';
    }
}

/** IANA places whose ID squeezes a name the underscore rule cannot recover. */
const PLACE_NAMES: Record<string, string> = {
    DumontDUrville: 'Dumont d’Urville',
};

/** The hours east of UTC a fixed-offset ID keeps (POSIX sign flipped), else null. */
function fixedOffsetHours(timeZone: string): number | null {
    const etc = /^Etc\/(?:GMT|UTC)([+-])(\d{1,2})$/.exec(timeZone);
    if (!etc) return null;
    const hours = Number(etc[2]);
    return etc[1] === '-' ? hours : -hours;
}

/**
 * What the dropdown SAYS for a zone — a pure relabel; the stored value is the
 * zone ID unchanged. The raw list read "Knox", "Center", "GMT+10": three-part
 * names lost their state, and the Etc/GMT zones carry the POSIX sign, so
 * "Etc/GMT+10" is ten hours BEHIND UTC — shown as "GMT+10" it said the
 * opposite of what a sailor reads (UX referee 2026-09-26).
 */
function zoneOptionLabel(timeZone: string, when: Date): string {
    const etc = /^Etc\/(?:GMT|UTC)([+-])(\d{1,2})$/.exec(timeZone);
    if (etc) return `Fixed offset (UTC${etc[2] === '0' || etc[1] === '-' ? '+' : '−'}${etc[2]})`;
    // Renamed zones show their current name ("Kolkata", "Kyiv"); the ID
    // stored stays the one the device gave.
    const parts = displayZoneId(timeZone).split('/');
    const city = zoneDisplayName(timeZone);
    const name = PLACE_NAMES[city] ?? city;
    const place = parts.length > 2 ? `${name}, ${parts[parts.length - 2].replace(/_/g, ' ')}` : name;
    const offset = utcOffsetLabel(timeZone, when);
    return offset && timeZone !== 'UTC' ? `${place} (${offset})` : place;
}

/**
 * The "Ship's position" option names the zone it is keeping, not a place:
 * "Ship's position (Brisbane)" read as where the boat IS (UX referee
 * 2026-09-26). The abbreviation where Intl has one, then the offset —
 * "AEST, UTC+10" — or just the offset where the abbreviation is itself only an
 * offset ("GMT+10").
 */
function autoZoneOptionLabel(timeZone: string, when: Date): string {
    const offset = utcOffsetLabel(timeZone, when);
    if (!offset) return 'Ship’s position';
    const abbr = clockInZone(when, timeZone).label;
    const parts = [/^(GMT|UTC)/.test(abbr) ? '' : abbr, offset].filter(Boolean);
    return `Ship’s position (${parts.join(', ')})`;
}

/**
 * How many of listTimeZones()' entries are its pinned head (this phone's zone,
 * then the curated common ones) rather than the device's full list after them.
 * The head is the shortest prefix whose remainder is exactly the device list
 * minus that prefix; with no device list, everything is the head.
 */
function pinnedHeadCount(all: string[]): number {
    let supported: string[] = [];
    try {
        const values = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
        if (typeof values === 'function') supported = values('timeZone');
    } catch {
        supported = [];
    }
    if (supported.length === 0) return all.length;
    for (let k = 1; k < Math.min(all.length, 40); k++) {
        const head = new Set(all.slice(0, k));
        const rest = supported.filter((z) => !head.has(z));
        if (rest.length === all.length - k && rest.every((z, i) => z === all[k + i])) return k;
    }
    return all.length;
}

/** The region an ID files under, for the grouped list. */
function zoneRegion(timeZone: string): string {
    if (timeZone.startsWith('Etc/') || !timeZone.includes('/')) return 'Fixed offsets';
    return timeZone.split('/')[0];
}

export const ShipClockSection: React.FC = () => {
    const [prefs, setPrefs] = useState<ShipClockPrefs>(() => readShipClockPrefs());
    useEffect(() => {
        const onPrefs = () => setPrefs(readShipClockPrefs());
        window.addEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
        return () => window.removeEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
    }, []);
    // Same IDs listTimeZones() gives, relabelled and grouped: the pinned head
    // (this phone's zone, then the ones boats round here keep) first, then
    // every other zone by region — this phone's region first — alphabetical
    // within it, instead of the device's raw database order.
    const zoneGroups = useMemo(() => {
        const now = new Date();
        const all = listTimeZones();
        const device = deviceTimeZone();
        const headCount = pinnedHeadCount(all);
        const labelled = all.map((id) => ({ id, label: zoneOptionLabel(id, now) }));
        const head = labelled.slice(0, headCount);
        const byRegion = new Map<string, { id: string; label: string }[]>();
        for (const z of labelled.slice(headCount)) {
            const region = zoneRegion(z.id);
            byRegion.set(region, [...(byRegion.get(region) ?? []), z]);
        }
        const home = zoneRegion(device);
        const regions = [...byRegion.keys()].sort((a, b) =>
            a === home
                ? -1
                : b === home
                  ? 1
                  : a === 'Fixed offsets'
                    ? 1
                    : b === 'Fixed offsets'
                      ? -1
                      : a.localeCompare(b),
        );
        return {
            head,
            // Fixed offsets in hour order (UTC−12 … UTC+14), not as text, which
            // put UTC+10 between UTC+1 and UTC+2 (UX scorecard run 7).
            regions: regions.map((region) => ({
                region,
                zones: (byRegion.get(region) ?? []).sort((a, b) => {
                    const ha = fixedOffsetHours(a.id);
                    const hb = fixedOffsetHours(b.id);
                    if (ha !== null && hb !== null) return ha - hb;
                    if (ha !== null) return 1;
                    if (hb !== null) return -1;
                    return a.label.localeCompare(b.label);
                }),
            })),
        };
    }, []);
    const shipZone = useWeatherOptional()?.weatherData?.timeZone ?? null;
    const effectiveZone = prefs.zone === SHIP_ZONE_AUTO ? (shipZone ?? deviceTimeZone()) : prefs.zone;

    const update = (patch: Partial<ShipClockPrefs>) => setPrefs(writeShipClockPrefs(patch));

    // It strikes what the FACE shows, not what the device clock says — the
    // 30- and 45-minute-offset zones (India, Nepal, Chatham) differ.
    const testBell = async () => {
        await ShipsBellChime.unlock();
        const face = clockInZone(new Date(), effectiveZone);
        if (!ShipsBellChime.strike(bellsAt(face.hour, face.minute))) {
            toast.error('The bell stayed quiet — an alarm is sounding, or this device has no audio.');
        }
    };
    const face = clockInZone(new Date(), effectiveZone);

    return (
        <Section title="Ship’s clock">
            <Row>
                <div className="flex-1">
                    <label className="text-sm text-white font-medium block">Ship’s bells</label>
                    <p className="text-xs text-gray-400">
                        Strike the bells on the hour and half hour, as the clock on the Instrument Panel shows them.
                    </p>
                </div>
                <Toggle
                    checked={prefs.bellsOn}
                    onChange={(on) => {
                        if (on) void ShipsBellChime.unlock();
                        update({ bellsOn: on });
                    }}
                    label="Ship’s bells"
                />
            </Row>
            <Row>
                <div className="flex-1">
                    <label className="text-sm text-white font-medium block">Test the bell</label>
                    <p className="text-xs text-gray-400">{bellsSpoken(bellsAt(face.hour, face.minute))} right now.</p>
                </div>
                <button
                    type="button"
                    onClick={() => void testBell()}
                    aria-label={`Test the bell — ${bellsSpoken(bellsAt(face.hour, face.minute))}`}
                    className="hit-target-44 min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-black tracking-wide text-white transition-all active:scale-[0.98]"
                >
                    Test
                </button>
            </Row>
            <Row>
                {/* Full width UNDER its label: beside it, at 55% of the row, the
                    select clipped its own value to "Ship's position · Bı". */}
                <div className="min-w-0 flex-1">
                    <label htmlFor="ship-clock-zone" className="text-sm text-white font-medium block">
                        Clock zone
                    </label>
                    {/* Plain words: 'a picked zone always wins' was cryptic (UX
                        scorecard run 8). */}
                    <p className="text-xs text-gray-400">
                        {shipZone
                            ? 'Follows the boat’s position unless you pick a zone.'
                            : 'Follows the boat’s position unless you pick a zone. Until she reports, it keeps this phone’s zone.'}
                    </p>
                    <select
                        id="ship-clock-zone"
                        value={prefs.zone}
                        onChange={(e) => update({ zone: e.target.value })}
                        aria-label="Clock time zone"
                        className="thalassa-select mt-3 w-full min-w-0 min-h-[44px] appearance-none rounded-xl border border-white/10 bg-black/40 pl-3 pr-9 text-sm text-white"
                    >
                        <option value={SHIP_ZONE_AUTO} className="bg-slate-900">
                            {autoZoneOptionLabel(shipZone ?? deviceTimeZone(), new Date())}
                        </option>
                        <optgroup label="Suggested" aria-label="Suggested">
                            {zoneGroups.head.map((z) => (
                                <option key={z.id} value={z.id} className="bg-slate-900">
                                    {z.label}
                                </option>
                            ))}
                        </optgroup>
                        {zoneGroups.regions.map(({ region, zones }) => (
                            <optgroup key={region} label={region} aria-label={region}>
                                {zones.map((z) => (
                                    <option key={z.id} value={z.id} className="bg-slate-900">
                                        {z.label}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </div>
            </Row>
        </Section>
    );
};
