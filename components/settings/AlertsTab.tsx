/**
 * AlertsTab — Weather notification thresholds settings panel.
 * Extracted from SettingsModal monolith (163 lines → standalone component).
 */
import React from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AlertsTab');
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { WindIcon, WaveIcon, EyeIcon, SunIcon, ThermometerIcon, RainIcon } from '../Icons';
import type { NotificationPreferences } from '../../types';

type ThresholdKey = Exclude<keyof NotificationPreferences, 'precipitation'>;

interface ThresholdSpec {
    key: ThresholdKey;
    title: string;
    /** Reads straight into the value beside it: "Sustained wind above" 20 kts. */
    trigger: string;
    /** Shown in the value well; '' for the unitless UV index. */
    unit: string;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    switchLabel: string;
}

// Units are the ones the evaluators compare in (NotificationManager and the
// check-weather-alerts function): kts, ft (internal wave height), nm, and °C —
// the raw forecast temperature. They are NOT the display preferences: a °F or
// metre label here would describe a number the alert never compares against.
const THRESHOLDS: ThresholdSpec[] = [
    {
        key: 'wind',
        title: 'High Wind',
        trigger: 'Sustained wind above',
        unit: 'kts',
        icon: WindIcon,
        iconClass: 'bg-purple-500/20 text-purple-300',
        switchLabel: 'High wind alert',
    },
    {
        key: 'gusts',
        title: 'Gusts',
        trigger: 'Peak gust above',
        unit: 'kts',
        icon: WindIcon,
        iconClass: 'bg-amber-500/20 text-amber-300',
        switchLabel: 'Gust alert',
    },
    {
        key: 'waves',
        title: 'High Seas',
        trigger: 'Significant wave height above',
        unit: 'ft',
        icon: WaveIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'High seas alert',
    },
    {
        key: 'swellPeriod',
        title: 'Long Period',
        trigger: 'Swell period above',
        unit: 's',
        icon: WaveIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'Long period swell alert',
    },
    {
        key: 'visibility',
        title: 'Low Vis',
        trigger: 'Visibility below',
        unit: 'nm',
        icon: EyeIcon,
        iconClass: 'bg-gray-500/20 text-gray-300',
        switchLabel: 'Low visibility alert',
    },
    {
        key: 'uv',
        title: 'High UV',
        trigger: 'UV index above',
        unit: '',
        icon: SunIcon,
        iconClass: 'bg-yellow-500/20 text-yellow-300',
        switchLabel: 'High UV alert',
    },
    {
        key: 'tempHigh',
        title: 'Heat Alert',
        trigger: 'Air temperature above',
        unit: '°C',
        icon: ThermometerIcon,
        iconClass: 'bg-red-500/20 text-red-300',
        switchLabel: 'Heat alert',
    },
    {
        key: 'tempLow',
        title: 'Freeze Alert',
        trigger: 'Air temperature below',
        unit: '°C',
        icon: ThermometerIcon,
        iconClass: 'bg-sky-500/20 text-sky-300',
        switchLabel: 'Freeze alert',
    },
];

export const AlertsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const idBase = React.useId();
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
                {/* Plain rows, not buttons: the switch alone is the toggle, so the
                    number field and the switch are never nested inside another
                    control. Every value well has the same shape (no "<" prefix —
                    above/below lives in the trigger line) so the values align. */}
                {THRESHOLDS.map(({ key, title, trigger, unit, icon: Icon, iconClass, switchLabel }) => (
                    <Row key={key}>
                        <div className="flex min-w-0 items-center gap-3">
                            <div className={`p-2 rounded-lg shrink-0 ${iconClass}`}>
                                <Icon className="w-6 h-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-white font-bold">{title}</p>
                                <p id={`${idBase}-${key}-trigger`} className="text-xs leading-snug text-gray-400">
                                    {trigger}
                                </p>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                            <div className="flex min-h-11 items-center gap-1.5 bg-black/40 pl-2.5 pr-2 py-0 rounded-lg border border-white/10">
                                <input
                                    aria-label={`${title} threshold${unit ? `, ${unit}` : ''}`}
                                    aria-describedby={`${idBase}-${key}-trigger`}
                                    type="number"
                                    value={settings.notifications[key].threshold}
                                    onChange={(e) => updateAlert(key, 'threshold', Number(e.target.value))}
                                    className="w-10 min-h-11 bg-transparent text-white text-right outline-hidden font-bold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                                {/* Fixed-width unit slot, even when empty, keeps every well the same width. */}
                                <span className="w-6 text-xs text-gray-400" aria-hidden="true">
                                    {unit}
                                </span>
                            </div>
                            <Toggle
                                label={switchLabel}
                                checked={settings.notifications[key].enabled}
                                onChange={(v) => updateAlert(key, 'enabled', v)}
                            />
                        </div>
                    </Row>
                ))}

                <Row>
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="p-2 bg-sky-500/20 text-sky-300 rounded-lg shrink-0">
                            <RainIcon className="w-6 h-6" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-white font-bold">Precipitation</p>
                            <p className="text-xs leading-snug text-gray-400">Rain or storm in the forecast</p>
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
