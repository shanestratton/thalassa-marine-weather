import type { useWeatherLayers } from './useWeatherLayers';
import type { HelixLayer } from './ThalassaHelixControl';
import type { CmemsLayerId } from './CmemsAttribution';
import type { CmemsLayerLoadState } from './useCmemsGridRefresh';
import { isUsableWindGrid, windForecastHourAtFrame } from './windTimeAxis';
import { PRESSURE_REFRESH_MS, pressureProvenance } from '../../services/weather/pressureProvenance';

type Weather = ReturnType<typeof useWeatherLayers>;
type SummaryLayer = Exclude<HelixLayer, null | 'velocity' | 'traffic'>;

export interface WeatherControlSummaryInput {
    weather: Weather;
    activeLayer?: HelixLayer;
    activeWeatherLayers: readonly HelixLayer[];
    cmemsLayerStates?: Partial<Record<CmemsLayerId, CmemsLayerLoadState>>;
    extraLegendCount?: number;
    lookingAhead?: boolean;
}

export interface WeatherControlSummary {
    primary: string;
    secondary: string;
    tone: 'neutral' | 'warning' | 'loading';
    /** Full source/time/status detail: never truncate this accessible button label. */
    accessibleText: string;
}

const LABELS: Record<SummaryLayer, string> = {
    wind: 'Wind',
    rain: 'Rain',
    pressure: 'Pressure',
    temperature: 'Air temperature',
    clouds: 'Clouds',
    currents: 'Currents',
    waves: 'Waves',
    sst: 'Sea temperature',
    chl: 'Chlorophyll',
    seaice: 'Sea ice',
    mld: 'Mixed-layer depth',
};
const MODELS: Record<string, string> = {
    gfs: 'GFS',
    ecmwf: 'ECMWF',
    icon: 'ICON',
    access_g: 'ACCESS-G',
    gem: 'GEM',
    aifs: 'AIFS',
    ukmo: 'UKMO',
    jma: 'JMA',
};
interface Issue {
    short: string;
    full: string;
    priority: number;
}
interface LayerSummary {
    label: string;
    source?: string;
    state: string;
    time: string;
    details: string[];
    issues: Issue[];
}

function normalizedLayer(layer: HelixLayer | undefined): SummaryLayer | null {
    if (layer === 'velocity') return 'wind';
    return layer && Object.hasOwn(LABELS, layer) ? (layer as SummaryLayer) : null;
}

function validMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function utc(value: unknown): string {
    return validMs(value) ? `${new Date(value).toISOString().slice(5, 16).replace('T', ' ')} UTC` : 'UTC unknown';
}

function issue(summary: LayerSummary, short: string, full = short, priority = 1): void {
    summary.issues.push({ short, full, priority });
}

function describeLayer(
    layer: SummaryLayer,
    weather: Weather,
    states: WeatherControlSummaryInput['cmemsLayerStates'],
): LayerSummary {
    const label = LABELS[layer];
    const result: LayerSummary = { label, state: 'Paused', time: 'UTC unknown', details: [], issues: [] };
    if (layer === 'wind') {
        result.source = MODELS[weather.windModel] ?? 'Model unknown';
        const grid = weather.windState?.grid;
        const ready =
            weather.windReady &&
            grid &&
            Array.isArray(grid.u) &&
            Array.isArray(grid.v) &&
            Array.isArray(grid.speed) &&
            isUsableWindGrid(grid);
        if (weather.windState?.error || (!ready && !weather.windState?.loading)) {
            result.state = 'Unavailable';
            issue(result, 'Wind unavailable', weather.windState?.error || 'Wind data unavailable', 0);
        } else if (!ready) {
            result.state = 'Loading';
            issue(result, 'Wind loading', 'Wind data is loading', 3);
        } else {
            result.state = weather.windPlaying ? 'Playing' : 'Paused';
            const hours = weather.windForecastHours ?? [];
            // Unlike the renderer helper, never clamp an invalid selection to a credible endpoint clock.
            const inRange =
                Number.isFinite(weather.windHour) &&
                weather.windHour >= 0 &&
                weather.windHour <= hours.length - 1 &&
                hours.length === grid?.totalHours &&
                hours.every(
                    (hour, index) => Number.isFinite(hour) && hour >= 0 && (index === 0 || hour > hours[index - 1]),
                );
            const offset = inRange ? windForecastHourAtFrame(hours, weather.windHour) : null;
            const reference = Date.parse(grid?.refTime ?? '');
            result.time = utc(offset !== null ? reference + offset * 3_600_000 : null);
            if (result.time === 'UTC unknown') issue(result, 'Wind time unknown', 'Wind valid UTC is unavailable', 2);
            if (weather.windState?.loading)
                issue(result, 'Wind refreshing', 'Wind is refreshing; the existing field is retained', 3);
        }
        if (!MODELS[weather.windModel]) issue(result, 'Wind model unknown', 'The wind model is unknown', 2);
        result.details.push('Model forecast, not observations');
        return result;
    }
    if (layer === 'rain') {
        const frame = weather.unifiedFramesRef?.current?.[weather.rainFrameIndex];
        const loading = weather.rainLoading || weather.rainImageLoading;
        if (loading) {
            result.state = 'Loading';
            issue(result, 'Rain loading', 'Rain imagery is loading', 3);
        } else if (!weather.rainReady || !frame) {
            result.state = 'Unavailable';
            issue(result, 'Rain unavailable', 'Rain imagery is unavailable', 0);
        } else {
            result.state = weather.rainPlaying ? 'Playing' : 'Paused';
            result.source = frame.type === 'radar' ? 'Radar' : frame.type === 'forecast' ? 'Forecast' : undefined;
            result.time = utc(frame.timeMs);
            result.details.push(
                frame.type === 'radar'
                    ? 'Radar by RainViewer'
                    : frame.type === 'forecast'
                      ? 'Forecast by Rainbow.ai'
                      : 'Rain source unknown',
            );
            if (!result.source) issue(result, 'Rain source unknown', 'Rain image source is unknown', 2);
            if (result.time === 'UTC unknown') issue(result, 'Rain time unknown', 'Rain frame UTC is unavailable', 2);
        }
        return result;
    }
    if (layer === 'pressure') {
        const now = weather.pressureClockMs;
        const provenance = pressureProvenance(
            weather.pressureSource,
            weather.pressureRefTime,
            Number.isFinite(now) ? now : NaN,
        );
        const reference = Date.parse(weather.pressureRefTime ?? '');
        result.source =
            weather.pressureSource === 'open-meteo'
                ? 'Open-Meteo'
                : weather.pressureSource === 'gfs'
                  ? 'GFS'
                  : undefined;
        result.time = utc(weather.pressureValidTimeMs);
        result.details.push('Mean sea-level pressure model forecast, not observations', provenance.label);
        if (weather.pressureTimeUnavailable) {
            result.state = 'Unavailable';
            issue(
                result,
                /coverage|cover|beyond|outside/i.test(weather.pressureTimeUnavailable)
                    ? 'Pressure outside coverage'
                    : 'Pressure time unavailable',
                weather.pressureTimeUnavailable,
                0,
            );
        } else if (
            !result.source ||
            !Number.isInteger(weather.framesReady) ||
            weather.framesReady <= 0 ||
            result.time === 'UTC unknown'
        ) {
            const pending = weather.pressureLoading || (!!result.source && !weather.pressureError);
            result.state = pending ? 'Loading' : 'Unavailable';
            issue(
                result,
                pending ? 'Pressure loading' : 'Pressure unavailable',
                pending ? 'The selected pressure frame is not yet drawable' : 'Pressure data unavailable',
                pending ? 3 : 0,
            );
        } else {
            result.state = weather.pressureFollowsWind ? 'Follows wind' : weather.isPlaying ? 'Playing' : 'Paused';
        }
        if (weather.pressureError)
            issue(result, 'Pressure refresh failed', `Pressure refresh unavailable: ${weather.pressureError}`, 0);
        if (weather.pressureSource === 'open-meteo') {
            result.details.push(
                'Open-Meteo coarse fallback; model run age unknown (the time-axis origin is not a model run)',
            );
            issue(result, 'Pressure run age unknown', 'Open-Meteo does not expose the model run age', 2);
        } else if (weather.pressureSource === 'gfs') {
            if (Number.isFinite(reference) && Number.isFinite(now) && reference > now) {
                issue(result, 'Pressure run in future', 'Pressure model run is ahead of the device clock', 0);
            } else if (!Number.isFinite(reference) || !Number.isFinite(now)) {
                issue(result, 'Pressure run age unknown', 'Pressure model run age is unknown', 2);
            } else {
                result.details.push(`Model run ${provenance.runAgeHours}h old`);
                if (provenance.stale) {
                    result.source = `GFS ${provenance.runAgeHours}h old`;
                    issue(
                        result,
                        `Pressure run ${provenance.runAgeHours}h old`,
                        `Stale pressure model run: ${provenance.runAgeHours} hours old`,
                        1,
                    );
                }
            }
        }
        if (validMs(weather.pressureFetchedAtMs)) {
            result.details.push(`Fetched ${utc(weather.pressureFetchedAtMs)}`);
            const age = now - weather.pressureFetchedAtMs;
            if (age < 0)
                issue(result, 'Pressure fetch in future', 'Pressure fetch time is ahead of the device clock', 1);
            else if (age >= PRESSURE_REFRESH_MS)
                issue(
                    result,
                    'Pressure refresh overdue',
                    `Pressure was last fetched ${Math.floor(age / 60_000)} minutes ago`,
                    1,
                );
        }
        return result;
    }
    if (layer === 'temperature' || layer === 'clouds') {
        result.source = 'OpenWeather';
        result.state = 'Static';
        issue(
            result,
            `${label} time unknown`,
            `${label}: static OpenWeather tiles; frame UTC and tile availability are not exposed`,
            2,
        );
        return result;
    }
    const marine = {
        currents: [weather.currentsHour, weather.currentsNowIdx, weather.currentsPlaying, 1, 'h'],
        waves: [weather.wavesHour, weather.wavesNowIdx, weather.wavesPlaying, 3, 'h'],
        sst: [weather.sstStep, weather.sstNowIdx, weather.sstPlaying, 1, 'd'],
        chl: [weather.chlStep, weather.chlNowIdx, weather.chlPlaying, 1, 'd'],
        seaice: [weather.seaiceStep, weather.seaiceNowIdx, weather.seaicePlaying, 1, 'd'],
        mld: [weather.mldStep, weather.mldNowIdx, weather.mldPlaying, 1, 'd'],
    } as const;
    const [rawStep, nowStep, playing, cadence, unit] = marine[layer];
    const step = Math.round(rawStep);
    const status = states?.[layer];
    result.source = 'CMEMS';
    const ready =
        status?.phase === 'ready' &&
        status.presentation === 'visible' &&
        status.attempt > 0 &&
        status.requestedStep === step &&
        status.verifiedStep === step &&
        !!status.sourceGeneration &&
        Number.isFinite(step) &&
        step >= 0;
    if (!ready) {
        const loading = status?.phase === 'loading' || status?.phase === 'ready';
        result.state = loading ? 'Loading' : 'Unavailable';
        issue(
            result,
            `${label} ${loading ? 'verifying' : 'unavailable'}`,
            `${label}: the exact selected Copernicus Marine frame is not verified as visible`,
            loading ? 3 : 0,
        );
    } else {
        result.state = playing ? 'Playing' : 'Paused';
        const relative = (step - nowStep) * cadence;
        if (Number.isFinite(relative)) result.time = `${relative > 0 ? '+' : ''}${relative}${unit} · UTC unknown`;
        result.details.push(
            `Copernicus Marine, selected step ${step}; relative offset is from the nearest current step, not an absolute timestamp`,
        );
        issue(result, `${label} UTC unknown`, `${label} valid UTC is not exposed by the rendered-layer state`, 2);
    }
    return result;
}

/** A deterministic two-line pill. No storage, requests, callbacks or wall-clock reads. */
export function summarizeWeatherControls(input: WeatherControlSummaryInput): WeatherControlSummary {
    const layers = [
        ...new Set(input.activeWeatherLayers.map(normalizedLayer).filter((layer): layer is SummaryLayer => !!layer)),
    ];
    const extras = Number.isFinite(input.extraLegendCount) ? Math.max(0, Math.floor(input.extraLegendCount!)) : 0;
    const total = layers.length + extras;
    const selected = normalizedLayer(input.activeLayer);
    const active = selected && layers.includes(selected) ? selected : layers[0];
    if (!active) {
        const primary = `Layer key · ${total} ${total === 1 ? 'layer' : 'layers'}`;
        const secondary = input.lookingAhead ? 'Look-ahead · Tap for key' : 'Tap for legend';
        return { primary, secondary, tone: 'neutral', accessibleText: `${primary}. ${secondary}.` };
    }
    const all = layers.map((layer) => ({
        layer,
        summary: describeLayer(layer, input.weather, input.cmemsLayerStates),
    }));
    const current = all.find(({ layer }) => layer === active)!.summary;
    const issues = all.flatMap(({ summary }) => summary.issues).sort((a, b) => a.priority - b.priority);
    const status = input.lookingAhead ? 'Look-ahead' : current.state;
    const otherCount = total - 1;
    const primary = [
        current.label,
        current.source,
        status,
        otherCount > 0 ? `+${otherCount} ${otherCount === 1 ? 'layer' : 'layers'}` : null,
    ]
        .filter(Boolean)
        .join(' · ');
    // Only the leading warning is abbreviated. Every issue remains in the accessible label,
    // and a visible +N alerts count makes other affected layers impossible to mistake for all-clear.
    const alert = issues[0] ? `${issues[0].short}${issues.length > 1 ? ` +${issues.length - 1} alerts` : ''}` : '';
    const secondary = [current.time, alert || (layers.length > 1 ? 'Independent times' : '')]
        .filter(Boolean)
        .join(' · ');
    const accessibleText = [
        primary,
        ...all.map(({ summary }) =>
            [summary.label, summary.source, summary.state, summary.time, ...summary.details].filter(Boolean).join('; '),
        ),
        ...issues.map(({ full }) => full),
        layers.length > 1 ? 'Active weather datasets have independent valid times; they are not synchronized.' : '',
        input.lookingAhead
            ? 'Passage look-ahead is active; use the passage timeline, not a second weather scrubber.'
            : '',
        extras > 0 ? `${extras} additional chart-layer legends.` : '',
        'Tap to expand controls and layer key.',
    ]
        .filter(Boolean)
        .join('. ');
    return {
        primary,
        secondary,
        tone: issues.some(({ priority }) => priority < 3) ? 'warning' : issues.length ? 'loading' : 'neutral',
        accessibleText,
    };
}
