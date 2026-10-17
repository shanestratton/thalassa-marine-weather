import { AIS_VESSEL_TYPES, normaliseAisDisplayFilters, type AisDisplayFilters } from '../../services/ais/aisFilter';
import { Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';

export function AisDisplaySettings({ settings, onSave }: Pick<SettingsTabProps, 'settings' | 'onSave'>) {
    const prefs = normaliseAisDisplayFilters(settings.aisDisplayFilters);
    const save = (patch: Partial<AisDisplayFilters>) => onSave({ aisDisplayFilters: { ...prefs, ...patch } });
    const selectClass = 'min-h-[44px] max-w-[50%] rounded-lg bg-slate-800 px-3 text-white';
    return (
        <div className="space-y-3">
            <p className="text-sm font-medium text-white">AIS display filters</p>
            <p className="text-xs text-gray-400">
                Chart and Targets list only. The collision alarm checks every target. DANGER, CAUTION and distress
                targets always show.
            </p>
            <Row>
                <label htmlFor="ais-display-type" className="text-sm text-white">
                    Vessel type
                </label>
                <select
                    id="ais-display-type"
                    className={selectClass}
                    value={prefs.vesselType}
                    onChange={(event) => save({ vesselType: event.target.value as AisDisplayFilters['vesselType'] })}
                >
                    {AIS_VESSEL_TYPES.map((type) => (
                        <option key={type} value={type}>
                            {type === 'all' ? 'All vessels' : type[0].toUpperCase() + type.slice(1)}
                        </option>
                    ))}
                </select>
            </Row>
            <Row>
                <label htmlFor="ais-display-speed" className="text-sm text-white">
                    Minimum AIS speed
                </label>
                <select
                    id="ais-display-speed"
                    className={selectClass}
                    value={prefs.minSpeedKn}
                    onChange={(event) => save({ minSpeedKn: Number(event.target.value) })}
                >
                    {[0, 0.5, 1, 2, 5, 10].map((speed) => (
                        <option key={speed} value={speed}>
                            {speed === 0 ? 'Any speed' : `${speed} kn`}
                        </option>
                    ))}
                </select>
            </Row>
            <Row>
                <label htmlFor="ais-display-source" className="text-sm text-white">
                    AIS source
                </label>
                <select
                    id="ais-display-source"
                    className={selectClass}
                    value={prefs.source}
                    onChange={(event) => save({ source: event.target.value as AisDisplayFilters['source'] })}
                >
                    <option value="all">All sources</option>
                    <option value="local">Boat receiver</option>
                    <option value="internet">Internet</option>
                </select>
            </Row>
            <Row>
                <p className="text-sm text-white">Hide moored and anchored vessels</p>
                <Toggle
                    label="Hide moored and anchored vessels"
                    checked={prefs.hideMoored}
                    onChange={(hideMoored) => save({ hideMoored })}
                />
            </Row>
        </div>
    );
}
