/**
 * AlertsTab — Weather notification thresholds settings panel.
 * Extracted from SettingsModal monolith (163 lines → standalone component).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AlertsTab');
import { Section, Row, RowChevron, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import {
    WindIcon,
    WaveIcon,
    EyeIcon,
    SunIcon,
    ThermometerIcon,
    RainIcon,
    CheckCircleIcon,
    AlertTriangleIcon,
    ThunderstormIcon,
    RadioTowerIcon,
} from '../Icons';
import { fetchCycloneWatchStatus, type CycloneWatchStatus } from '../../services/cycloneWatchStatus';
import { fetchOfficialAlertsWatchStatus } from '../../services/officialAlertsWatchStatus';
import { fetchWeatherAlertStatus, type WeatherAlertStatus } from '../../services/weatherAlertStatus';
import {
    FORECAST_ALERTS_VERSION,
    LOOKAHEAD_CHOICES,
    lookaheadHours,
} from '../../supabase/functions/_shared/forecast-alerts/contract';
import { extractCoords, extractDisplayName } from '../../utils/savedLocations';
import { GustIcon, WavePeriodIcon } from '../icons/GlassGlyphs';
import type { NotificationPreferences, UnitPreferences } from '../../types';
import {
    ktsToMph,
    ktsToKmh,
    ktsToMps,
    ftToM,
    mToFt,
    celsiusToFahrenheit,
    fahrenheitToCelsius,
} from '../../utils/units';
const WeatherWatchSection = React.lazy(() => import('./WeatherWatchSection'));
const ShoreContactsSection = React.lazy(() => import('./ShoreContactsSection'));

type ThresholdKey = Exclude<keyof NotificationPreferences, 'precipitation'>;

/** How one threshold is shown to the skipper and stored for the evaluators. */
interface ThresholdUnit {
    /** Shown after the value in the well; '' for the unitless UV index. */
    label: string;
    toDisplay: (stored: number) => number;
    toStored: (shown: number) => number;
}

interface ThresholdSpec {
    key: ThresholdKey;
    title: string;
    /** Reads straight into the value beside it: "Sustained wind above" 20 kts. */
    trigger: string;
    unit: (units: Partial<UnitPreferences>) => ThresholdUnit;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    switchLabel: string;
    /** Where the intro's promise does not hold, the row says so. */
    note?: string;
}

// The server job (supabase/functions/check-weather-alerts) checked wind, gusts,
// visibility, UV, temperature and rain. It had no wave or swell-period check,
// so those two alarms fired only from the in-app check, while Thalassa is open;
// they used to sit under the intro's every-30-min promise as if covered
// (build 123, W1-02). The look-ahead check (129-07, was W2-03) reads the seas
// too, so the note goes once the deployed function says it is that check
// (weather_alert_status), and stays on a phone whose server is older.
// Short enough for one line beside the value well at 375 pt (109 px at 12 px
// system-ui, where 'Air temperature above' is 126).
const OPEN_APP_ONLY = 'Only with app open';

const round2 = (n: number) => Math.round(n * 100) / 100;
const same = (label: string): ThresholdUnit => ({ label, toDisplay: (n) => n, toStored: (n) => n });
const scaled = (label: string, toDisplay: (n: number) => number, toStored: (n: number) => number): ThresholdUnit => ({
    label,
    toDisplay,
    // Rounded so a converted entry stores as 21.72 kts, not 21.723…; that is
    // well inside every display unit's own rounding, so the shown value holds.
    toStored: (n) => round2(toStored(n)),
});

// The evaluators (NotificationManager and the check-weather-alerts function)
// compare in kts, ft, s, nm and °C, so that is what is STORED. The skipper
// sees and types each threshold in their own display unit (Settings →
// Preferences), converted both ways here (UX scorecard run 6: High Seas read
// '5 ft' for a skipper whose Seas unit is metres).
const speedUnit = (units: Partial<UnitPreferences>): ThresholdUnit => {
    switch (units.speed) {
        case 'mph':
            return scaled('mph', ktsToMph, (n) => n / 1.15078);
        case 'kmh':
            return scaled('km/h', ktsToKmh, (n) => n / 1.852);
        case 'mps':
            return scaled('m/s', ktsToMps, (n) => n / 0.514444);
        default:
            return same('kts');
    }
};

const waveUnit = (units: Partial<UnitPreferences>): ThresholdUnit =>
    // Same fallback as the Seas picker in Preferences.
    (units.waveHeight || 'm') === 'ft' ? same('ft') : scaled('m', ftToM, mToFt);

const visibilityUnit = (units: Partial<UnitPreferences>): ThresholdUnit => {
    switch (units.visibility || 'nm') {
        case 'mi':
            return scaled(
                'mi',
                (n) => n * 1.15078,
                (n) => n / 1.15078,
            );
        case 'km':
            return scaled(
                'km',
                (n) => n * 1.852,
                (n) => n / 1.852,
            );
        default:
            return same('nm');
    }
};

const tempUnit = (units: Partial<UnitPreferences>): ThresholdUnit =>
    units.temp === 'F' ? scaled('°F', celsiusToFahrenheit, fahrenheitToCelsius) : same('°C');

// One naming style, sentence case, no abbreviations: 'Low Vis', and 'Heat
// Alert' beside 'High UV', read as three conventions (UX scorecard run 7).
const THRESHOLDS: ThresholdSpec[] = [
    {
        key: 'wind',
        title: 'High wind',
        trigger: 'Sustained wind above',
        unit: speedUnit,
        icon: WindIcon,
        iconClass: 'bg-purple-500/20 text-purple-300',
        switchLabel: 'High wind alert',
    },
    {
        key: 'gusts',
        title: 'Gusts',
        trigger: 'Peak gust above',
        unit: speedUnit,
        icon: GustIcon,
        iconClass: 'bg-amber-500/20 text-amber-300',
        switchLabel: 'Gust alert',
    },
    {
        key: 'waves',
        title: 'High seas',
        // Short enough for one line beside the value well at 375 pt: the
        // longer 'Significant wave height above' left 'above' on a line of its
        // own and made this row ~18 pt taller than its neighbours (UX
        // scorecard run 8).
        trigger: 'Wave height above',
        unit: waveUnit,
        icon: WaveIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'High seas alert',
        note: OPEN_APP_ONLY,
    },
    {
        key: 'swellPeriod',
        title: 'Long period',
        trigger: 'Swell period above',
        unit: () => same('s'),
        icon: WavePeriodIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'Long period swell alert',
        note: OPEN_APP_ONLY,
    },
    {
        key: 'visibility',
        title: 'Low visibility',
        trigger: 'Visibility below',
        unit: visibilityUnit,
        icon: EyeIcon,
        iconClass: 'bg-gray-500/20 text-gray-300',
        switchLabel: 'Low visibility alert',
    },
    {
        key: 'uv',
        title: 'High UV',
        trigger: 'UV index above',
        unit: () => same(''),
        icon: SunIcon,
        iconClass: 'bg-yellow-500/20 text-yellow-300',
        switchLabel: 'High UV alert',
    },
    {
        key: 'tempHigh',
        title: 'Heat',
        trigger: 'Air temperature above',
        unit: tempUnit,
        icon: ThermometerIcon,
        iconClass: 'bg-red-500/20 text-red-300',
        switchLabel: 'Heat alert',
    },
    // 'Cold', not 'Freeze': the alarm defaults to 5 °C, well above freezing
    // (UX scorecard run 8). The stored key stays tempLow.
    {
        key: 'tempLow',
        title: 'Cold',
        trigger: 'Air temperature below',
        unit: tempUnit,
        icon: ThermometerIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'Cold alert',
    },
];

const formatThreshold = (n: number) => String(parseFloat(n.toFixed(1)));

/**
 * A disarmed row reads as disarmed, not only by its small grey switch: with
 * every alert off, nine full-strength bold values read as nine armed alarms
 * (UX scorecard run 8). Off, the icon tile fades and the title, trigger line
 * and value step down to a quieter ink. That ink is a colour, not opacity, so
 * it keeps AA: slate-400 on the dark card (~7:1), and #5b6b80 on the daylight
 * card (~5:1). Not slate-500 there: Settings' daylight card is white/70 over
 * the slate-200 page (~#f6f8fa), where slate-500 measures ~4.48:1, under AA
 * for this 12 px trigger line. The legacy grey utilities cannot do it, because
 * styles/legibility.css paints them all the same caption ink.
 */
const DISARMED_INK = 'text-[#94a3b8] [.display-light_&]:text-[#5b6b80]';
const iconTileClass = (armed: boolean) =>
    `p-2 rounded-lg shrink-0 transition-opacity ${armed ? '' : 'opacity-40 grayscale'}`;

// ── Threshold value well ─────────────────────────────────────────
// The whole well is the <label>, so a tap on the unit or the padding lands in
// the field; the input is sized to its digits so the well stays ~64 pt and the
// trigger line beside it no longer wraps.
const ThresholdField: React.FC<{
    title: string;
    describedBy: string;
    stored: number;
    unit: ThresholdUnit;
    armed: boolean;
    onCommit: (stored: number) => void;
}> = ({ title, describedBy, stored, unit, armed, onCommit }) => {
    // The typed text while the field is being edited, so a converted value
    // never snaps under the skipper's thumb mid-entry.
    const [draft, setDraft] = useState<string | null>(null);
    const shown = Number.isFinite(stored) ? formatThreshold(unit.toDisplay(stored)) : '';
    const value = draft ?? shown;
    const digits = Math.min(Math.max(value.length, 2), 5);
    return (
        // Off: fainter chrome and quieter digits (DISARMED_INK) rather than
        // opacity, which would drop the value below AA in daylight (UX
        // scorecard run 6).
        <label
            className={`flex h-11 min-w-16 cursor-text items-center justify-end gap-1 rounded-lg border px-2 transition-colors ${
                armed ? 'bg-black/40 border-white/10' : 'bg-black/20 border-white/5'
            }`}
        >
            <input
                aria-label={`${title} threshold${unit.label ? `, ${unit.label}` : ''}`}
                aria-describedby={describedBy}
                // No inputMode="decimal": the iOS decimal pad has no minus key,
                // and a Cold threshold can be below zero.
                type="number"
                value={value}
                placeholder="--"
                onChange={(e) => {
                    setDraft(e.target.value);
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) onCommit(unit.toStored(n));
                }}
                onBlur={() => setDraft(null)}
                style={{ width: `${digits}ch` }}
                className={`min-h-11 min-w-0 bg-transparent text-right outline-hidden tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                    armed ? 'text-white font-bold' : `${DISARMED_INK} font-medium`
                }`}
            />
            {unit.label && (
                <span className={`shrink-0 text-xs ${armed ? 'text-gray-400' : DISARMED_INK}`} aria-hidden="true">
                    {unit.label}
                </span>
            )}
        </label>
    );
};

// ── Notification permission ──────────────────────────────────────
type PermissionState = 'granted' | 'denied' | 'prompt' | null;

/** Weather alerts reach a backgrounded phone by push, so on iOS the push
 *  permission is the one that decides whether an armed alert ever arrives. */
async function readNotificationPermission(): Promise<PermissionState> {
    if (Capacitor.isNativePlatform()) {
        try {
            const { receive } = await PushNotifications.checkPermissions();
            if (receive === 'granted') return 'granted';
            if (receive === 'denied') return 'denied';
            return 'prompt';
        } catch (e) {
            log.warn(' push permission check failed:', e);
            return null;
        }
    }
    if (typeof Notification === 'undefined') return null;
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return 'prompt';
}

const PermissionStatus: React.FC<{ state: PermissionState }> = ({ state }) => {
    if (state === null) return null;
    const native = Capacitor.isNativePlatform();
    const allowed = state === 'granted';
    const text = allowed
        ? 'Notifications allowed'
        : state === 'denied'
          ? native
              ? 'Notifications are off. Turn on in iOS Settings.'
              : 'Notifications are blocked. Allow them in your browser settings.'
          : native
            ? 'Notifications not allowed yet'
            : 'Your browser asks to allow notifications when you turn an alert on.';
    return (
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
            {allowed ? (
                <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
                <AlertTriangleIcon className="h-4 w-4 shrink-0 text-amber-400" />
            )}
            <p className="text-sm leading-snug text-gray-200">{text}</p>
        </div>
    );
};

/**
 * Signed out, this phone gets its alerts only while Thalassa is open: the
 * in-app check (NotificationManager) runs in the app, and the 30-minute server
 * check and its push go to a signed-in account. The intro said sign-in was
 * needed but never that this phone is signed out, so a skipper arming High
 * wind would assume they were covered overnight (UX scorecard run 10). The
 * way to sign in is Account & Cloud's sign-in card, one tap away.
 */
const SignedOutNotice: React.FC<{ onOpenAccount?: () => void }> = ({ onOpenAccount }) => (
    <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2">
        <AlertTriangleIcon className="h-4 w-4 shrink-0 text-amber-400" />
        <p className="min-w-0 flex-1 py-1 text-sm leading-snug text-gray-200">
            Not signed in: alerts only while Thalassa is open
        </p>
        {onOpenAccount && (
            <button
                type="button"
                onClick={onOpenAccount}
                aria-label="Sign in, in Account & Cloud"
                className="-mr-2 inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-sm font-bold text-sky-300"
            >
                Sign in
                <RowChevron className="h-3.5 w-3.5 text-sky-300" />
            </button>
        )}
    </div>
);

/**
 * "Cyclone warnings near the boat" (129-09): the server's cyclone-watch push.
 * A safety alert, so on by default (unset = on) and never paywalled, here with
 * the other pushed alerts. Hidden until the watcher has answered
 * (services/cycloneWatchStatus.ts), so no switch is offered that nothing
 * honours; once it has, a watcher gone quiet or a feed that is down is said,
 * never shown as no cyclones.
 */
/** "14 Oct 03:10 UTC", as the storm view writes its times. */
const utcLabel = (ms: number) => {
    const d = new Date(ms).toUTCString();
    return `${+d.slice(5, 7)} ${d.slice(8, 11)} ${d.slice(17, 22)} UTC`;
};

const isPosition = (p: { lat?: unknown; lon?: unknown } | null | undefined): boolean =>
    typeof p?.lat === 'number' &&
    typeof p?.lon === 'number' &&
    Number.isFinite(p.lat + p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180;

/**
 * Whether the account carries a position the watcher can always measure from
 * (cyclone-watch resolveBoat): the home port as the app reads it, or the place
 * the weather is set to. Without one, only a fix the Pi or Guardian has sent.
 */
function hasSavedPosition(settings: AlertsTabProps['settings']): boolean {
    const home = settings.homePort?.trim();
    const saved = settings.savedLocationCoords;
    const homeAt = home && (saved?.[home] ?? saved?.[extractDisplayName(home)] ?? extractCoords(home));
    return isPosition(homeAt || null) || isPosition(settings.defaultLocationCoords);
}

const CycloneWarningsSection: React.FC<{ on: boolean; positioned: boolean; onChange: (on: boolean) => void }> = ({
    on,
    positioned,
    onChange,
}) => {
    const [status, setStatus] = useState<CycloneWatchStatus | null>(null);
    useEffect(() => {
        let live = true;
        void fetchCycloneWatchStatus().then((answer) => {
            if (live) setStatus(answer);
        });
        return () => {
            live = false;
        };
    }, []);
    if (!status) return null;
    const ran = Date.parse(status.ranAt);
    const down = Date.parse(status.unavailableSince ?? '');
    const notes = [
        Number.isFinite(down) && `Cyclone data unavailable since ${utcLabel(down)}`,
        Date.now() - ran > 2 * 3_600_000 && `Not checked since ${utcLabel(ran)}`,
        !positioned &&
            "No home port position is saved. Unless the Pi or Guardian has sent the boat's position, the watch has nothing to measure from: set your home port on the map.",
    ].filter((note): note is string => typeof note === 'string');
    return (
        <Section title="Cyclones">
            <Row>
                <div className="flex min-w-0 items-center gap-3">
                    <div className={`${iconTileClass(on)} bg-rose-500/20 text-rose-300`}>
                        {/* The cyclone push's own toast icon; the unused CycloneIcon would add ~400 B. */}
                        <ThunderstormIcon className="w-6 h-6" />
                    </div>
                    <div className="min-w-0">
                        <p className={`font-bold ${on ? 'text-white' : DISARMED_INK}`}>
                            Cyclone warnings near the boat
                        </p>
                        <p className={`text-xs leading-snug ${on ? 'text-gray-400' : DISARMED_INK}`}>
                            A notice within 600 NM. Urgent within 300 NM, or when the forecast track comes within 300 NM
                            in the next 72 h. From the boat&apos;s last position, else your home port.
                        </p>
                        {notes.map((note) => (
                            <p key={note} className="text-xs leading-snug text-amber-300">
                                {note}
                            </p>
                        ))}
                    </div>
                </div>
                <Toggle label="Cyclone warnings near the boat" checked={on} onChange={onChange} />
            </Row>
        </Section>
    );
};

/**
 * "Official marine warnings at the boat" and "Small craft advisories"
 * (129-06): official-alerts-watch's push of the issuers' own marine and
 * coastal warnings. Safety alerts, so both on by default (unset = on) and
 * never paywalled, beside the cyclone switch. Hidden until the watcher has
 * answered (services/officialAlertsWatchStatus.ts), so no switch is offered
 * that nothing honours; a watcher gone quiet is said. The sub-switch is
 * shown but cannot be operated while the main one is off.
 */
const OfficialWarningsSwitches: React.FC<{
    marine: boolean;
    advisories: boolean;
    positioned: boolean;
    onChange: (patch: Partial<AlertsTabProps['settings']>) => void;
}> = ({ marine, advisories, positioned, onChange }) => {
    const [ranAt, setRanAt] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void fetchOfficialAlertsWatchStatus().then((answer) => {
            if (live) setRanAt(answer?.ranAt ?? null);
        });
        return () => {
            live = false;
        };
    }, []);
    if (!ranAt) return null;
    const ran = Date.parse(ranAt);
    const notes = [
        Date.now() - ran > 30 * 60_000 && `Not checked since ${utcLabel(ran)}`,
        !positioned &&
            "No home port position is saved. Unless the Pi or Guardian has sent the boat's position, there is nothing to match warnings to: set your home port on the map.",
    ].filter((note): note is string => typeof note === 'string');
    const smallCraftOn = marine && advisories;
    return (
        <Section title="Official warnings">
            <Row>
                <div className="flex min-w-0 items-center gap-3">
                    <div className={`${iconTileClass(marine)} bg-sky-500/20 text-sky-300`}>
                        <RadioTowerIcon className="w-6 h-6" />
                    </div>
                    <div className="min-w-0">
                        <p className={`font-bold ${marine ? 'text-white' : DISARMED_INK}`}>
                            Official marine warnings at the boat
                        </p>
                        <p className={`text-xs leading-snug ${marine ? 'text-gray-400' : DISARMED_INK}`}>
                            Gale, storm and tsunami warnings in the issuer&apos;s words, at once, day or night.
                        </p>
                    </div>
                </div>
                <Toggle
                    label="Official marine warnings at the boat"
                    checked={marine}
                    onChange={(on) => onChange({ officialMarineWarnings: on })}
                />
            </Row>
            <Row>
                <div className="flex min-w-0 items-center gap-3 pl-12">
                    <div className="min-w-0">
                        <p className={`font-bold ${smallCraftOn ? 'text-white' : DISARMED_INK}`}>
                            Small craft advisories
                        </p>
                        <p className={`text-xs leading-snug ${smallCraftOn ? 'text-gray-400' : DISARMED_INK}`}>
                            And watches. Overnight they wait for 07:00 at the boat, unless they begin within 3 h.
                        </p>
                    </div>
                </div>
                <Toggle
                    label="Small craft advisories"
                    checked={smallCraftOn}
                    disabled={!marine}
                    onChange={(on) => onChange({ smallCraftAdvisories: on })}
                />
            </Row>
            <div className="px-4 py-3 text-xs leading-snug text-gray-400">
                <p>
                    Land warnings show in the app only, on the Warnings page. From the boat&apos;s last position, else
                    your home port.
                </p>
                {notes.map((note) => (
                    <p key={note} className="mt-1 text-amber-300">
                        {note}
                    </p>
                ))}
            </div>
        </Section>
    );
};

/**
 * "Looking ahead" (129-07): how far ahead the background check reads the wind
 * and sea thresholds, "Good window opens", and what the check last saw at the
 * position it reads, in its own words (already in the skipper's units, and
 * never a UKMO value: CC BY-SA, so named and counted, never quoted). Shown
 * only once the deployed function reports the look-ahead version.
 */
const LookingAhead: React.FC<{
    status: WeatherAlertStatus;
    hours: number;
    goodWindow: boolean;
    place?: string;
    onSave: SettingsTabProps['onSave'];
}> = ({ status, hours, goodWindow, place, onSave }) => {
    const labelId = React.useId();
    const ran = Date.parse(status.ranAt);
    const stale = !(Date.now() - ran <= 2 * 3_600_000);
    const at = status.basis === 'last-known' ? 'your last known position' : place?.trim() || 'your saved location';
    // Where WAM has no water the seas lines quote Météo-France's model: credit it there too.
    const mfwam = status.lines.some((line) => line.includes('MFWAM'));
    return (
        <Section title="Looking ahead">
            <div className="border-b border-white/5 px-4 py-3">
                <p id={labelId} className="font-bold text-white">
                    Look ahead
                </p>
                <div role="group" aria-labelledby={labelId} className="mt-2 grid grid-cols-3 gap-2">
                    {LOOKAHEAD_CHOICES.map((h) => (
                        <button
                            key={h}
                            type="button"
                            aria-pressed={h === hours}
                            onClick={() => onSave({ alertLookaheadHours: h })}
                            className={`min-h-11 rounded-lg border text-sm font-bold ${
                                h === hours
                                    ? 'border-sky-500/40 bg-sky-500/15 text-white'
                                    : 'border-white/10 bg-white/2 text-gray-300'
                            }`}
                        >
                            {h} h
                        </button>
                    ))}
                </div>
            </div>
            <Row>
                <div className="flex min-w-0 items-center gap-3">
                    <div className={`${iconTileClass(goodWindow)} bg-emerald-500/20 text-emerald-300`}>
                        <CheckCircleIcon className="w-6 h-6" />
                    </div>
                    <div className="min-w-0">
                        <p className={`font-bold ${goodWindow ? 'text-white' : DISARMED_INK}`}>Good window opens</p>
                        <p className={`text-xs leading-snug ${goodWindow ? 'text-gray-400' : DISARMED_INK}`}>
                            When the models agree on 6 h inside your wind and sea limits.
                        </p>
                    </div>
                </div>
                <Toggle
                    label="Good window opens"
                    checked={goodWindow}
                    onChange={(on) => onSave({ goodWindowAlerts: on })}
                />
            </Row>
            <div className="space-y-1 px-4 py-3 text-xs leading-snug text-gray-300">
                {stale && <p className="text-amber-300">Not checked since {utcLabel(ran)}</p>}
                <p className="text-gray-400">
                    {status.basis
                        ? `${stale ? 'Last read' : `Checked ${utcLabel(ran)}`} at ${at}`
                        : 'Not checked at your position yet.'}
                </p>
                {status.lines.map((line) => (
                    <p key={line}>{line}</p>
                ))}
                <p className="text-gray-400">
                    Forecast data: ECMWF, DWD ICON{mfwam ? ', Météo-France' : ''}. UKMO counted, never quoted.
                </p>
            </div>
        </Section>
    );
};

interface AlertsTabProps extends SettingsTabProps {
    /** Opens Settings → Account & Cloud, where the sign-in card is. */
    onOpenAccount?: () => void;
}

export const AlertsTab: React.FC<AlertsTabProps> = ({ settings, onSave, onOpenAccount }) => {
    const idBase = React.useId();
    // Only once the session check has answered, so a signed-in skipper never
    // sees the notice flash while it runs.
    const signedOut = useAuthStore((state) => state.authChecked && state.user === null);
    const [permission, setPermission] = useState<PermissionState>(null);
    const [ahead, setAhead] = useState<WeatherAlertStatus | null>(null);
    useEffect(() => {
        let live = true;
        void fetchWeatherAlertStatus().then((answer) => {
            if (live) setAhead(answer);
        });
        return () => {
            live = false;
        };
    }, []);
    // The deployed check reads the seas and looks ahead only from this version on.
    const looksAhead = !!ahead && ahead.version >= FORECAST_ALERTS_VERSION;
    const hours = lookaheadHours(settings.alertLookaheadHours);
    const refreshPermission = useCallback(() => {
        void readNotificationPermission().then(setPermission);
    }, []);

    // Re-read on return from iOS Settings, where the skipper turns it on.
    useEffect(() => {
        refreshPermission();
        const onVisible = () => {
            if (document.visibilityState === 'visible') refreshPermission();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [refreshPermission]);

    const updateAlert = async (
        key: keyof typeof settings.notifications,
        field: 'enabled' | 'threshold',
        value: boolean | number,
    ) => {
        if (field === 'enabled' && value === true) {
            if ('Notification' in window && Notification.permission !== 'granted') {
                try {
                    await Notification.requestPermission();
                } catch (e) {
                    log.warn(' user denied or API unavailable:', e);
                }
                refreshPermission();
            }
        }
        onSave({
            notifications: {
                ...settings.notifications,
                [key]: { ...settings.notifications[key as keyof typeof settings.notifications], [field]: value },
            },
        });
    };

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <Section title="Thresholds">
                {/* Where, how often and how an armed alert arrives, so nobody arms
                    'High wind' before an offshore leg expecting a warning that
                    cannot come. It says what the server job does
                    (supabase/functions/check-weather-alerts: every 30 min, the
                    home port or the last known position, sent by push to a
                    signed-in account) (UX scorecard run 9). */}
                <p className="border-b border-white/5 px-4 py-3 text-xs leading-relaxed text-gray-300">
                    {/* Once the server looks ahead (129-07), each check is said as it is:
                        only wind and gusts are agreed across models. */}
                    {looksAhead
                        ? `Checked about every 30 min at your home port or last known position. Wind and gusts: up to ${hours} h ahead, sent when 2 of 3 models agree. Seas: up to ${hours} h ahead, from one named wave model. The rest: the hour under way.`
                        : 'Checked about every 30 min at your home port or last known position, and sent as a notification.'}{' '}
                    Needs a data connection, and signing in for alerts while Thalassa is closed.
                </p>
                {signedOut && <SignedOutNotice onOpenAccount={onOpenAccount} />}
                <PermissionStatus state={permission} />
                {/* Plain rows, not buttons: the switch alone is the toggle, so the
                    number field and the switch are never nested inside another
                    control. Every value well has the same shape (no "<" prefix —
                    above/below lives in the trigger line) so the values align. */}
                {THRESHOLDS.map(({ key, title, trigger, unit, icon: Icon, iconClass, switchLabel, note: caveat }) => {
                    const armed = settings.notifications[key].enabled;
                    const note = looksAhead ? undefined : caveat;
                    const triggerId = `${idBase}-${key}-trigger`;
                    const noteId = `${idBase}-${key}-note`;
                    return (
                        <Row key={key}>
                            <div className="flex min-w-0 items-center gap-3">
                                <div className={`${iconTileClass(armed)} ${iconClass}`}>
                                    <Icon className="w-6 h-6" />
                                </div>
                                <div className="min-w-0">
                                    <p className={`font-bold ${armed ? 'text-white' : DISARMED_INK}`}>{title}</p>
                                    <p
                                        id={triggerId}
                                        className={`text-xs leading-snug ${armed ? 'text-gray-400' : DISARMED_INK}`}
                                    >
                                        {trigger}
                                    </p>
                                    {note && (
                                        <p
                                            id={noteId}
                                            className={`text-xs leading-snug ${armed ? 'text-gray-400' : DISARMED_INK}`}
                                        >
                                            {note}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                                <ThresholdField
                                    title={title}
                                    describedBy={note ? `${triggerId} ${noteId}` : triggerId}
                                    stored={settings.notifications[key].threshold}
                                    unit={unit(settings.units ?? {})}
                                    armed={armed}
                                    onCommit={(v) => updateAlert(key, 'threshold', v)}
                                />
                                <Toggle
                                    label={switchLabel}
                                    checked={armed}
                                    onChange={(v) => updateAlert(key, 'enabled', v)}
                                />
                            </div>
                        </Row>
                    );
                })}

                <Row>
                    <div className="flex min-w-0 items-center gap-3">
                        <div
                            className={`${iconTileClass(settings.notifications.precipitation.enabled)} bg-sky-500/20 text-sky-300`}
                        >
                            <RainIcon className="w-6 h-6" />
                        </div>
                        <div className="min-w-0">
                            <p
                                className={`font-bold ${settings.notifications.precipitation.enabled ? 'text-white' : DISARMED_INK}`}
                            >
                                Precipitation
                            </p>
                            <p
                                className={`text-xs leading-snug ${settings.notifications.precipitation.enabled ? 'text-gray-400' : DISARMED_INK}`}
                            >
                                Rain or storm in the forecast
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                        <Toggle
                            label="Precipitation alert"
                            checked={settings.notifications.precipitation.enabled}
                            onChange={(v) => updateAlert('precipitation', 'enabled', v)}
                        />
                    </div>
                </Row>
            </Section>
            {looksAhead && (
                <LookingAhead
                    status={ahead}
                    hours={hours}
                    goodWindow={settings.goodWindowAlerts === true}
                    place={settings.defaultLocation}
                    onSave={onSave}
                />
            )}
            <OfficialWarningsSwitches
                marine={settings.officialMarineWarnings !== false}
                advisories={settings.smallCraftAdvisories !== false}
                positioned={hasSavedPosition(settings)}
                onChange={onSave}
            />
            <CycloneWarningsSection
                on={settings.cycloneWarnings !== false}
                positioned={hasSavedPosition(settings)}
                onChange={(on) => onSave({ cycloneWarnings: on })}
            />
            <React.Suspense fallback={null}>
                <WeatherWatchSection />
                <ShoreContactsSection />
            </React.Suspense>
        </div>
    );
};
