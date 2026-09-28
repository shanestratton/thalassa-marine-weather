/**
 * GeneralTab — Preferences panel: units, default location, legal, factory reset.
 * Extracted from SettingsModal to reduce component size.
 */
import React from 'react';
import {
    FIELD_LABEL_CLASS,
    Section,
    Row,
    RowChevron,
    SatelliteModeGlyph,
    Toggle,
    type SettingsTabProps,
} from './SettingsPrimitives';
import { FleetSharingSection } from './FleetSharingSection';
import { DisplayModeSection, OrientationSection, VisualPreferencesSection } from './AestheticsTab';
import { ShipClockSection } from './ShipClockSection';
import { SmartPolarsSetting } from './SmartPolarsSetting';
import { MapPinIcon, TrashIcon } from '../Icons';
import { Button } from '../ui/Button';
import type { LengthUnit } from '../../types';
import { openExternalUrl, openFeedbackDestination, THALASSA_TERMS_URL } from '../../services/externalLinks';
import { canAccess } from '../../services/SubscriptionService';
import { SATELLITE_MODE_ENFORCED } from '../../services/networkPolicy';
import { OFFSHORE_MODELS } from '../../services/weather/forecastModels';
import { offshoreModelHelper } from '../dashboard/ModelPickerSheet';

/** The Settings menu row's icon tile (SettingsModal's MENU_ICON_TILE): the soft
 *  surface with the one sky accent on the glyph, in both display modes. */
const ROW_ICON_TILE: React.CSSProperties = {
    background: 'var(--day-ui-surface-soft, rgba(255,255,255,0.04))',
    color: 'var(--day-ui-accent, #7dd3fc)',
};

/** The saved home that follows the phone (or the boat) rather than a port. */
const FOLLOWS_YOU = 'Current Location';

/** One field's select, the same recipe for every unit. */
const SELECT_CLASS =
    'thalassa-select w-full min-h-11 appearance-none bg-black/40 border border-white/10 rounded-lg pl-3 pr-9 py-2 text-white text-sm';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'Version 1.2.0 · built 26 Sep, 16:47' — the bundle stamp in the phone's own
 * time, not the UTC developer stamp 'bundle 2026-09-26 06:47Z' (UX scorecard
 * run 6). It still dates the JavaScript actually running, so a stale install
 * shows at a glance. A stamp that will not parse shows '--', never a guess.
 */
function formatVersionLine(version: string | undefined, stamp: string): string {
    const v = version?.trim() || '--';
    // __BUILD_STAMP__ is 'YYYY-MM-DD HH:MMZ'; spell it as full ISO for Safari.
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})Z$/.exec(stamp.trim());
    const built = m ? new Date(`${m[1]}T${m[2]}:00Z`) : null;
    if (!built || Number.isNaN(built.getTime())) return `Version ${v} · built --`;
    const hh = String(built.getHours()).padStart(2, '0');
    const mm = String(built.getMinutes()).padStart(2, '0');
    return `Version ${v} · built ${built.getDate()} ${MONTHS[built.getMonth()]}, ${hh}:${mm}`;
}

interface GeneralTabProps extends SettingsTabProps {
    onLocationSelect: (location: string) => void;
    /** Pins the home port at this phone's position; resolves false when no fix came back. */
    onDetectLocation: () => Promise<boolean> | void;
    onShowFactoryReset: () => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({ settings, onSave, onDetectLocation, onShowFactoryReset }) => {
    const updateUnit = (type: keyof typeof settings.units, value: string) => {
        onSave({ units: { ...settings.units, [type]: value } });
    };
    const followsYou = settings.defaultLocation === FOLLOWS_YOU;
    const satellite = !!settings.satelliteMode;
    // 'Pin here' asks for a fix that can take up to 15 s and can fail: it used
    // to show nothing while it looked, and nothing when no fix came back (UX
    // scorecard run 9). On success the field shows the pinned name. The
    // button's minimum width fits 'Locating…' (min-w-29 did not: the field
    // shifted ~3 px at 375), so nothing moves while it looks.
    const [pin, setPin] = React.useState<'idle' | 'locating' | 'failed'>('idle');
    const pinHere = async () => {
        if (pin === 'locating') return;
        setPin('locating');
        let pinned: boolean | void = false;
        try {
            pinned = await onDetectLocation();
        } catch {
            pinned = false;
        }
        setPin(pinned === false ? 'failed' : 'idle');
    };
    const helpId =
        pin === 'failed' ? 'settings-home-port-nofix' : followsYou ? 'settings-home-port-follows' : undefined;

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            {/* In order of use (UX scorecard run 10): Display mode (the night
                red tint) leads, Units follow it — the most-used setting sat
                sixth, below orientation, home port and the ship's clock — then
                the screen switches, home port and clock, the forecast and
                routing choices, and the rarely touched ones (network mode,
                Smart Polars, AIS sharing, orientation lock). Legal, Beta and
                Reset this phone stay last. */}
            <DisplayModeSection settings={settings} onSave={onSave} />

            {/* Australian spelling, as the rest of the app ('Centre', 'Centreboard')
                — the options said 'Meters' and 'Liters' (UX scorecard run 7).
                Sentence case and the one field label (UX scorecard run 8). */}
            <Section title="Units">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4">
                    <div>
                        <label htmlFor="settings-unit-speed" className={FIELD_LABEL_CLASS}>
                            Wind speed
                        </label>
                        <select
                            id="settings-unit-speed"
                            value={settings.units.speed}
                            onChange={(e) => updateUnit('speed', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            <option value="kts">Knots</option>
                            <option value="mph">mph</option>
                            <option value="kmh">km/h</option>
                            <option value="mps">m/s</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-distance" className={FIELD_LABEL_CLASS}>
                            Distance
                        </label>
                        <select
                            id="settings-unit-distance"
                            value={settings.units.distance}
                            onChange={(e) => updateUnit('distance', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            <option value="nm">Nautical miles</option>
                            <option value="mi">Miles</option>
                            <option value="km">Kilometres</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-seas" className={FIELD_LABEL_CLASS}>
                            Seas (wave height)
                        </label>
                        <select
                            id="settings-unit-seas"
                            value={settings.units.waveHeight || 'm'}
                            onChange={(e) => updateUnit('waveHeight', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            <option value="m">Metres</option>
                            <option value="ft">Feet</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-length" className={FIELD_LABEL_CLASS}>
                            Tides / length
                        </label>
                        <select
                            id="settings-unit-length"
                            value={settings.units.length}
                            onChange={(e) => {
                                const val = e.target.value;
                                onSave({
                                    units: {
                                        ...settings.units,
                                        length: val as LengthUnit,
                                        tideHeight: val as LengthUnit,
                                    },
                                });
                            }}
                            className={SELECT_CLASS}
                        >
                            <option value="ft">Feet</option>
                            <option value="m">Metres</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-temp" className={FIELD_LABEL_CLASS}>
                            Temperature
                        </label>
                        <select
                            id="settings-unit-temp"
                            value={settings.units.temp}
                            onChange={(e) => updateUnit('temp', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            <option value="C">Celsius</option>
                            <option value="F">Fahrenheit</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-visibility" className={FIELD_LABEL_CLASS}>
                            Visibility
                        </label>
                        <select
                            id="settings-unit-visibility"
                            value={settings.units.visibility || 'nm'}
                            onChange={(e) => updateUnit('visibility', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            <option value="nm">Nautical miles</option>
                            <option value="mi">Miles</option>
                            <option value="km">Kilometres</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="settings-unit-volume" className={FIELD_LABEL_CLASS}>
                            Liquid volume
                        </label>
                        <select
                            id="settings-unit-volume"
                            value={settings.units.volume || 'gal'}
                            onChange={(e) => updateUnit('volume', e.target.value)}
                            className={SELECT_CLASS}
                        >
                            {/* US gallons: what 'gal' converts as (3.785 L), not the imperial 4.546. */}
                            <option value="gal">US gallons</option>
                            <option value="l">Litres</option>
                        </select>
                    </div>
                </div>
            </Section>

            <VisualPreferencesSection settings={settings} onSave={onSave} />

            {/* The home the Glass opens on. Its label is the one Settings form
                label (FIELD_LABEL_CLASS) over a full-width field, and it is
                called what the menu row calls it, 'Home port'. The saved value
                that follows you ('Current Location') is not shown as if typed
                into the box: the box stays empty and says what it does (UX
                scorecard run 8). Typing a port replaces it, as before. The
                button beside it says what it does, 'Pin here' (run 9): icon
                only, beside 'Follows you', it read as a no-op. */}
            <Section title="Location & time">
                <div className="p-4">
                    <label htmlFor="settings-home-port" className={FIELD_LABEL_CLASS}>
                        Home port
                    </label>
                    <div className="flex gap-2">
                        <input
                            id="settings-home-port"
                            type="text"
                            value={followsYou ? '' : settings.defaultLocation || ''}
                            onChange={(e) => {
                                setPin('idle');
                                onSave({ defaultLocation: e.target.value });
                            }}
                            aria-describedby={helpId}
                            className="min-h-11 min-w-0 flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                            placeholder={followsYou ? 'Follows you' : 'City, Country'}
                        />
                        <button
                            type="button"
                            onClick={() => void pinHere()}
                            aria-busy={pin === 'locating' || undefined}
                            className="min-h-11 min-w-32 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-500/20 px-3 text-sm font-bold text-sky-300"
                            aria-label={
                                pin === 'locating'
                                    ? 'Locating where you are now'
                                    : 'Pin here: set home port to where you are now'
                            }
                        >
                            {pin === 'locating' ? (
                                <span
                                    aria-hidden="true"
                                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                                />
                            ) : (
                                <MapPinIcon className="h-4 w-4 shrink-0" />
                            )}
                            <span aria-hidden="true">{pin === 'locating' ? 'Locating…' : 'Pin here'}</span>
                        </button>
                    </div>
                    {pin === 'failed' ? (
                        <p id="settings-home-port-nofix" role="status" className="mt-1.5 text-xs text-amber-300">
                            No GPS fix came back. Try again, or type a port.
                        </p>
                    ) : (
                        followsYou && (
                            <p id="settings-home-port-follows" className="mt-1.5 text-xs text-gray-400">
                                The Glass opens on your current position. Type a port, or Pin here to fix it at this
                                spot.
                            </p>
                        )
                    )}
                </div>
            </Section>

            {/* Ship's bells, test, clock zone — out of the Instrument Panel's
                Bells page (Shane 2026-09-09). */}
            <ShipClockSection />

            {/* Offshore model — unlocked during the public beta. Named for
                when it applies, and described from the same table as the
                Glass's model sheet, with no claims nothing here backs ('best
                overall accuracy', 'professional-grade': UX scorecard run 9). */}
            {canAccess(settings.subscriptionTier, 'weatherFull') && (
                <Section title="Model used beyond 20 nm">
                    <div className="p-4">
                        <p className="text-xs text-gray-400 mb-4 leading-relaxed">
                            Forecast model used when you&apos;re more than 20 nm offshore. Everywhere else, including
                            inland, the Glass uses the model on its own forecast-model pill.
                        </p>
                        <div className="space-y-2">
                            {OFFSHORE_MODELS.map((m) => ({
                                value: m.id,
                                label: m.label,
                                tag: m.id === 'sg' ? 'Default' : undefined,
                                desc: offshoreModelHelper(m.id),
                            })).map((opt) => {
                                const isActive = (settings.offshoreModel || 'sg') === opt.value;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        // Pressed state, like Display Mode's buttons: the ring
                                        // alone told a screen reader nothing about which is chosen.
                                        aria-label={`${opt.label} offshore model — ${opt.desc}`}
                                        aria-pressed={isActive}
                                        onClick={() => onSave({ offshoreModel: opt.value })}
                                        className={`w-full text-left p-3 rounded-xl border transition-all duration-200 flex items-center gap-3 ${
                                            isActive
                                                ? 'bg-sky-500/10 border-sky-500/30'
                                                : 'bg-white/2 border-white/5 hover:bg-white/5'
                                        }`}
                                    >
                                        <div
                                            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                                isActive ? 'border-sky-500' : 'border-white/20'
                                            }`}
                                        >
                                            {isActive && <div className="w-2 h-2 rounded-full bg-sky-400" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className={`text-sm font-bold ${isActive ? 'text-white' : 'text-gray-300'}`}
                                                >
                                                    {opt.label}
                                                </span>
                                                {opt.tag && (
                                                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
                                                        {opt.tag}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </Section>
            )}

            {/* High-fidelity ocean currents, moved here from Vessel Profile,
                which keeps a line that points here (UX scorecard run 9). Same
                setting (currentNrtEnabled), same effect. Not behind the
                weatherFull gate: the switch was never gated. */}
            <Section title="Ocean currents">
                <Row>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium">High-fidelity ocean currents</p>
                        <p className="text-xs text-gray-400">
                            Use recent ocean currents (about 5 days old) instead of monthly averages. Helps where a
                            strong current decides your timing.
                        </p>
                    </div>
                    <Toggle
                        label="High-fidelity ocean currents"
                        checked={settings.currentNrtEnabled === true}
                        onChange={(on) => onSave({ currentNrtEnabled: on })}
                    />
                </Row>
            </Section>

            {/* Satellite mode, moved here from Account & Cloud, which keeps a
                line that points here (UX scorecard run 8; Shane 2026-09-09:
                switches live in Preferences). Same setting, same effect. The
                amber wash still marks the mode as on. */}
            <Section title="Network mode">
                <div
                    className={`p-4 transition-colors duration-500 ${satellite ? 'bg-linear-to-br from-amber-500/15 to-orange-500/10' : ''}`}
                >
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3">
                            <div
                                className={`shrink-0 p-2.5 rounded-xl transition-colors duration-500 ${satellite ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-400'}`}
                                aria-hidden="true"
                            >
                                <SatelliteModeGlyph className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-white font-medium text-sm">Satellite mode</p>
                                <p className="text-xs text-gray-400">
                                    {satellite
                                        ? 'Forecast only • grids, radar, AIS & uploads paused'
                                        : 'For Iridium GO! & metered connections'}
                                </p>
                            </div>
                        </div>
                        <Toggle
                            label="Satellite mode"
                            checked={satellite}
                            onChange={(v) => onSave({ satelliteMode: v })}
                        />
                    </div>
                    {satellite && (
                        <ul
                            role="list"
                            className="mt-3 pt-3 border-t border-amber-500/20 space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-300"
                        >
                            {/* The forecast still runs every source it normally
                                does — five small JSON calls every three hours.
                                "StormGlass only" was never true; the cadence is
                                the saving, and the cadence is what is promised.
                                The middle of the list is rendered FROM the policy
                                module, so what it says and what the fetchers
                                enforce are one thing. */}
                            <li className="flex items-center gap-2 text-xs">
                                <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                                <span className="text-amber-200/70">Weather updates every 3 hours</span>
                            </li>
                            {SATELLITE_MODE_ENFORCED.map((entry) => (
                                <li key={entry.kind} className="flex items-center gap-2 text-xs">
                                    <span
                                        className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400"
                                        aria-hidden="true"
                                    />
                                    <span className="text-amber-200/70">{entry.label}</span>
                                </li>
                            ))}
                            <li className="flex items-center gap-2 text-xs">
                                <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                                <span className="text-amber-200/70">
                                    Log entries stored on-device until back on land
                                </span>
                            </li>
                            <li className="flex items-center gap-2 text-xs">
                                <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                                <span className="text-amber-200/70">
                                    Diary relay uploads pause until normal network mode resumes
                                </span>
                            </li>
                        </ul>
                    )}
                </div>
            </Section>

            {/* Smart Polars, moved here from the Polars page, which keeps its
                state and a link here (UX scorecard run 8). */}
            <Section title="Polars">
                <SmartPolarsSetting settings={settings} onSave={onSave} />
            </Section>

            {/* AIS crowd-feed consent — moved here from the NMEA Gateway page
                (Shane 2026-09-09: "i want to move most toggles there"). */}
            <Section title="Share what you hear">
                <FleetSharingSection />
            </Section>

            {/* Set once, so it sits with the rarely touched sections. */}
            <OrientationSection settings={settings} onSave={onSave} />

            {/* Legal and Beta Support are plain rows in their section card, like
                every section above — each used to sit in a bordered card of its
                own inside the section card (UX scorecard run 6). Each row's
                name starts with its printed title, as a voice user says it. */}
            <Section title="Legal">
                <Row
                    onClick={() => void openExternalUrl(THALASSA_TERMS_URL)}
                    label="Terms of Service & Privacy Policy: read them on thalassawx.app"
                    className="min-h-[44px]"
                >
                    <div className="flex flex-1 min-w-0 items-center gap-3">
                        {/* The Settings menu row's tile (soft surface, sky glyph,
                            20 px icon in 8 px padding), so these two link rows
                            match every Settings root row, title inset included;
                            the filled blue chip was a second recipe (UX
                            scorecard run 10). */}
                        <div className="shrink-0 rounded-lg p-2" style={ROW_ICON_TILE} aria-hidden="true">
                            <svg
                                className="h-5 w-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm text-white font-bold">Terms of Service & Privacy Policy</p>
                            <p className="text-xs text-gray-300 mt-0.5">Read them on thalassawx.app</p>
                        </div>
                    </div>
                    <RowChevron />
                </Row>
            </Section>
            <Section title="Beta support">
                <Row
                    onClick={() => void openFeedbackDestination()}
                    label="Send beta feedback: report a bug or an idea"
                    className="min-h-[44px]"
                >
                    <div className="flex flex-1 min-w-0 items-center gap-3">
                        <div className="shrink-0 rounded-lg p-2" style={ROW_ICON_TILE} aria-hidden="true">
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m3.75 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H15M21 12c0 4.142-4.03 7.5-9 7.5a10.2 10.2 0 01-3.36-.56L3 20.25l1.55-3.49A6.77 6.77 0 013 12c0-4.142 4.03-7.5 9-7.5s9 3.358 9 7.5z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white">Send beta feedback</p>
                            <p className="mt-0.5 text-xs text-gray-300">
                                Report a bug or an idea. Your app version is filled in for you.
                            </p>
                        </div>
                    </div>
                    <RowChevron />
                </Row>
            </Section>
            {/* It holds only the factory reset, so it says so (UX scorecard run 9). */}
            <Section title="Reset this phone" tone="danger">
                <div className="p-4">
                    <Button
                        variant="danger"
                        aria-label="Factory reset: erase the vessel profile, saved ports, alerts and preferences on this phone"
                        onClick={onShowFactoryReset}
                        className="w-full"
                    >
                        <TrashIcon className="w-4 h-4" /> Factory reset
                    </Button>
                </div>
            </Section>
            {/* The web-bundle build time, in local time — it dates the
                JavaScript actually running, so a stale install is visible at a
                glance. If this does not match roughly when you last pressed Run
                in Xcode, the phone is running old code. */}
            <p className="pb-2 pt-1 text-center text-xs tracking-wide text-white/50">
                {formatVersionLine(import.meta.env.VITE_APP_VERSION, __BUILD_STAMP__)}
            </p>
        </div>
    );
};
