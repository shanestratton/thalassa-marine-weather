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
import { clockInZone, deviceTimeZone, listTimeZones, zoneDisplayName } from '../../utils/timeZones';
import { useWeatherOptional } from '../../context/WeatherContext';
import { toast } from '../Toast';
import {
    SHIP_CLOCK_PREFS_EVENT,
    SHIP_ZONE_AUTO,
    readShipClockPrefs,
    writeShipClockPrefs,
    type ShipClockPrefs,
} from '../../services/shipClockPrefs';

export const ShipClockSection: React.FC = () => {
    const [prefs, setPrefs] = useState<ShipClockPrefs>(() => readShipClockPrefs());
    useEffect(() => {
        const onPrefs = () => setPrefs(readShipClockPrefs());
        window.addEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
        return () => window.removeEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
    }, []);
    const zoneOptions = useMemo(() => listTimeZones(), []);
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
                <div className="flex-1">
                    <label htmlFor="ship-clock-zone" className="text-sm text-white font-medium block">
                        Clock zone
                    </label>
                    <p className="text-xs text-gray-400">
                        Ship’s position follows the boat; a picked zone always wins.
                    </p>
                </div>
                <select
                    id="ship-clock-zone"
                    value={prefs.zone}
                    onChange={(e) => update({ zone: e.target.value })}
                    aria-label="Clock time zone"
                    className="max-w-[55%] min-w-0 min-h-[44px] rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-white"
                >
                    <option value={SHIP_ZONE_AUTO} className="bg-slate-900">
                        {shipZone
                            ? `Ship’s position · ${zoneDisplayName(shipZone)}`
                            : `Ship’s position · ${zoneDisplayName(deviceTimeZone())} (phone until she reports)`}
                    </option>
                    {zoneOptions.map((z) => (
                        <option key={z} value={z} className="bg-slate-900">
                            {zoneDisplayName(z)}
                        </option>
                    ))}
                </select>
            </Row>
        </Section>
    );
};
