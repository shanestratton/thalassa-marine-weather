import React, { useState } from 'react';
import { Section, Toggle } from './SettingsPrimitives';
import {
    INSTRUMENT_SECTIONS,
    saveInstrumentPanelPreferences,
    useInstrumentPanelPreferences,
} from '../../services/instruments/panelPreferences';
export function InstrumentPanelSettings() {
    const prefs = useInstrumentPanelPreferences();
    const [failed, setFailed] = useState(false);
    const save = (next: Parameters<typeof saveInstrumentPanelPreferences>[0]) =>
        setFailed(!saveInstrumentPanelPreferences(next));
    return (
        <Section title="Instrument Panel">
            <p className="mb-3 text-xs text-gray-400">
                Sections keep their order and hide automatically without data. The clock remains if every other section
                is hidden.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {INSTRUMENT_SECTIONS.map((id) => (
                    <label key={id} className="flex min-h-11 items-center justify-between gap-3 text-sm text-white">
                        <span>Show {id}</span>
                        <Toggle
                            checked={!prefs.hidden.includes(id)}
                            onChange={() =>
                                save({
                                    hidden: prefs.hidden.includes(id)
                                        ? prefs.hidden.filter((v) => v !== id)
                                        : [...prefs.hidden, id],
                                })
                            }
                        />
                    </label>
                ))}
            </div>
            <label className="mt-3 flex min-h-11 items-center justify-between gap-3 text-sm text-white">
                <span>Performance in passage HUD</span>
                <Toggle
                    checked={prefs.performanceHud}
                    onChange={() => save({ performanceHud: !prefs.performanceHud })}
                />
            </label>
            <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-white">
                <span>Local layline guides on Obs</span>
                <Toggle checked={prefs.laylines} onChange={() => save({ laylines: !prefs.laylines })} />
            </label>
            <p className="text-xs text-gray-400">
                Laylines require an explicit Under sail confirmation, qualified true wind, and a followed mark within 5
                nm. These display guides do not steer or alter a route.
            </p>
            {failed && (
                <p role="alert" className="text-sm text-amber-300">
                    Preferences could not be saved on this device.
                </p>
            )}
        </Section>
    );
}
