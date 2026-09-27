/**
 * AlertsTab — Weather notification thresholds settings panel.
 * Extracted from SettingsModal monolith (163 lines → standalone component).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AlertsTab');
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import {
    WindIcon,
    WaveIcon,
    EyeIcon,
    SunIcon,
    ThermometerIcon,
    RainIcon,
    CheckCircleIcon,
    AlertTriangleIcon,
} from '../Icons';
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
}

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
    },
    {
        key: 'swellPeriod',
        title: 'Long period',
        trigger: 'Swell period above',
        unit: () => same('s'),
        icon: WavePeriodIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'Long period swell alert',
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

export const AlertsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const idBase = React.useId();
    const [permission, setPermission] = useState<PermissionState>(null);
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
                <PermissionStatus state={permission} />
                {/* Plain rows, not buttons: the switch alone is the toggle, so the
                    number field and the switch are never nested inside another
                    control. Every value well has the same shape (no "<" prefix —
                    above/below lives in the trigger line) so the values align. */}
                {THRESHOLDS.map(({ key, title, trigger, unit, icon: Icon, iconClass, switchLabel }) => {
                    const armed = settings.notifications[key].enabled;
                    return (
                        <Row key={key}>
                            <div className="flex min-w-0 items-center gap-3">
                                <div className={`${iconTileClass(armed)} ${iconClass}`}>
                                    <Icon className="w-6 h-6" />
                                </div>
                                <div className="min-w-0">
                                    <p className={`font-bold ${armed ? 'text-white' : DISARMED_INK}`}>{title}</p>
                                    <p
                                        id={`${idBase}-${key}-trigger`}
                                        className={`text-xs leading-snug ${armed ? 'text-gray-400' : DISARMED_INK}`}
                                    >
                                        {trigger}
                                    </p>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                                <ThresholdField
                                    title={title}
                                    describedBy={`${idBase}-${key}-trigger`}
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
        </div>
    );
};
