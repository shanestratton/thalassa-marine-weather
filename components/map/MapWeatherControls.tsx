/**
 * MapWeatherControls — chart weather timeline, legend, model picker and
 * declutter affordance.
 *
 * Kept separate from MapHub so the control surface can evolve and be tested
 * without entangling it with Mapbox lifecycle and route-planning state.
 */
import React, { useId, useState } from 'react';
import { useWeatherControlsAutoHide } from './useWeatherControlsAutoHide';
import { summarizeWeatherControls } from './weatherControlSummary';
import { CREDITS_STRIP_POSITION_CLASS, creditsStripTop } from './creditsStrip';
import type { useWeatherLayers } from './useWeatherLayers';
import type { WeatherLayer } from './mapConstants';
import { ThalassaHelixControl, LegendDock, weatherLayerLabel, type HelixLayer } from './ThalassaHelixControl';
import { WindModelFieldSelector } from './WindModelFieldSelector';
import { LayersGlyph } from './LayersGlyph';
import { usePassageLookAheadOn } from '../../stores/passageHudStore';
import { isCmemsFeatureEnabled } from './cmemsFeatureAvailability';
import { isUsableWindGrid, windHoursFromNow, windForecastHourAtFrame } from './windTimeAxis';
import type { CmemsLayerId } from './CmemsAttribution';
import type { CmemsLayerLoadState } from './useCmemsGridRefresh';
import { isCmemsRenderedStepReady } from './useCmemsPlayback';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatCloseInWind, useCloseInWindReadout } from './closeInWind';
import { openExternalUrl } from '../../services/externalLinks';
import {
    pressureProvenance,
    pressureSourceText,
    pressureValidTimeText,
} from '../../services/weather/pressureProvenance';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

const CMEMS_STATUS_LABELS: Record<CmemsLayerId, string> = {
    currents: 'Currents',
    waves: 'Waves',
    sst: 'Sea temperature',
    chl: 'Chlorophyll',
    seaice: 'Sea ice',
    mld: 'Mixed-layer depth',
};

interface MapWeatherControlsProps {
    weather: WeatherControlsWeather;
    cmemsLayerStates?: Partial<Record<CmemsLayerId, CmemsLayerLoadState>>;
    /** False while plotting, in an embed, or in pin view. */
    visible: boolean;
    embedded: boolean;
    controlsHidden: boolean;
    onControlsHiddenChange: (hidden: boolean) => void;
    /** Already-active non-weather chart layers; this surface does not own their lifecycle. */
    extraLegend?: React.ReactNode;
    extraLegendCount?: number;
}

/**
 * The chart-only weather control cluster. It deliberately accepts the weather
 * hook result rather than owning map/weather state: MapHub remains the single
 * owner of layer lifecycle, while this component is responsible only for how
 * the already-active layer is read and controlled.
 */
export function MapWeatherControls({
    weather,
    cmemsLayerStates = {},
    visible,
    embedded,
    controlsHidden,
    onControlsHiddenChange,
    extraLegend,
    extraLegendCount,
}: MapWeatherControlsProps): React.ReactElement | null {
    // Above the early return: a hook is called on every render or on none.
    const passageLookAheadOn = usePassageLookAheadOn();
    const [selectedLayer, setSelectedLayer] = useState<HelixLayer>(null);
    const summaryId = useId();
    // Close-in mode's local wind (high zoom), in the user's speed unit.
    const closeInWind = useCloseInWindReadout();
    const speedUnit = useSettingsStore((state) => state.settings?.units?.speed);
    const windCloseIn = closeInWind
        ? { value: formatCloseInWind(closeInWind, speedUnit), source: closeInWind.source, stale: closeInWind.stale }
        : null;

    // Identify active weather layers (only scrubber-capable types).
    const weatherKeys: HelixLayer[] = [
        'wind',
        'rain',
        'pressure',
        'temperature',
        'clouds',
        'currents',
        'waves',
        'sst',
        'chl',
        'seaice',
        'mld',
    ];
    const activeWeatherLayers = weatherKeys.filter((key) =>
        key === 'wind'
            ? weather.activeLayers.has('wind' as WeatherLayer) || weather.activeLayers.has('velocity')
            : weather.activeLayers.has(key as WeatherLayer),
    );
    // While the skipper is looking ahead along the route, the passage strip's
    // scrubber stands in this row and drives the wind timeline itself. Two time
    // sliders for one field is how a skipper reads the wrong hour, so these
    // controls take their own designed "hidden" state — and do not offer to
    // come back until the glance is over. Credits are not part of that state:
    // they stay exactly where they are.
    const lookingAhead = passageLookAheadOn && !embedded;
    const showTimeline = !controlsHidden && !lookingAhead;
    const hasExtraLegend = extraLegend != null && extraLegend !== false;
    const surfaceAvailable = hasExtraLegend || (!lookingAhead && activeWeatherLayers.length > 0);
    const showSurface = !controlsHidden && surfaceAvailable;
    // The selected tab only chooses which dataset to control. It never
    // changes the other layers' clocks or turns layers on/off.
    const activeLayer =
        selectedLayer && activeWeatherLayers.includes(selectedLayer) ? selectedLayer : activeWeatherLayers[0];
    const autoHide = useWeatherControlsAutoHide({
        enabled: visible && !embedded && surfaceAvailable,
        hidden: controlsHidden,
        contextKey: `${activeWeatherLayers.join(',')}:${extraLegendCount ?? 0}:${lookingAhead}`,
        onHiddenChange: onControlsHiddenChange,
    });
    if (!visible) return null;
    const compactSummary = summarizeWeatherControls({
        weather,
        activeLayer: activeLayer ?? null,
        activeWeatherLayers,
        cmemsLayerStates,
        extraLegendCount: hasExtraLegend ? Math.max(1, extraLegendCount || 1) : 0,
        lookingAhead,
        windCloseIn,
    });
    const hideControlsButton = (
        <button
            type="button"
            onClick={autoHide.hide}
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300 transition-transform active:scale-95"
            aria-label={hasExtraLegend ? 'Hide layer controls' : 'Hide weather controls'}
            title="Hide controls"
        >
            <span className="text-[14px] leading-none">▾</span>
        </button>
    );
    const hasWindLayer = activeWeatherLayers.includes('wind');
    const pressureFollowsWind = weather.pressureFollowsWind ?? hasWindLayer;
    const currentRainFrame = weather.unifiedFramesRef?.current?.[weather.rainFrameIndex];
    const showRainViewerAttribution =
        weather.activeLayers.has('rain') && weather.rainReady && currentRainFrame?.type === 'radar';
    // The FORECAST rain frames are another provider's product, and until now no
    // one was named while one of them was on screen (the RainViewer credit is,
    // rightly, for radar frames only). The passage look-ahead puts forecast
    // frames up far more often, so the gap closes here: same slot, same spot,
    // whichever of the two is showing. Like its sibling it is never gated on the
    // time controls or on look-ahead — a credit shows whenever its imagery does.
    const showRainForecastAttribution =
        weather.activeLayers.has('rain') && weather.rainReady && currentRainFrame?.type === 'forecast';
    const rainIsLoading = Boolean(weather.rainLoading || weather.rainImageLoading);
    const cmemsRequestedSteps: Record<CmemsLayerId, number> = {
        currents: Math.round(weather.currentsHour),
        waves: Math.round(weather.wavesHour),
        sst: Math.round(weather.sstStep),
        chl: Math.round(weather.chlStep),
        seaice: Math.round(weather.seaiceStep),
        mld: Math.round(weather.mldStep),
    };
    const isCmemsLayer = (layer: HelixLayer): layer is CmemsLayerId =>
        layer !== null && Object.prototype.hasOwnProperty.call(cmemsRequestedSteps, layer);
    const validTime = (ms: number | undefined | null) =>
        Number.isFinite(ms) && ms != null
            ? `Valid ${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')} UTC`
            : 'Valid time unavailable';
    const windReference = Date.parse(weather.windState?.grid?.refTime ?? '');
    const windOffset = windForecastHourAtFrame(weather.windForecastHours ?? [], weather.windHour);
    const windValidTime = validTime(
        Number.isFinite(windReference) && windOffset != null ? windReference + windOffset * 3_600_000 : null,
    );
    const pressureFetched =
        weather.pressureFetchedAtMs != null && Number.isFinite(weather.pressureFetchedAtMs)
            ? ` · Fetched ${new Date(weather.pressureFetchedAtMs).toISOString().slice(5, 16).replace('T', ' ')} UTC`
            : '';
    const pressureCaption = `Model forecast · ${pressureSourceText(pressureProvenance(weather.pressureSource, weather.pressureRefTime, weather.pressureClockMs))} · ${pressureValidTimeText(weather.pressureValidTimeMs)}${weather.pressureError && weather.pressureSource ? ' · Saved data; refresh unavailable' : ''}${pressureFetched}`;
    const unavailableLayers = activeWeatherLayers.filter((layer) => {
        if (layer === 'wind')
            return !weather.windReady || !isUsableWindGrid(weather.windState?.grid) || !!weather.windState?.error;
        if (layer === 'pressure')
            return (
                !weather.pressureSource ||
                !weather.framesReady ||
                weather.pressureValidTimeMs === null ||
                !!weather.pressureTimeUnavailable
            );
        if (layer === 'rain') return !weather.rainReady || rainIsLoading || !currentRainFrame;
        if (isCmemsLayer(layer))
            return (
                !isCmemsFeatureEnabled(layer) ||
                !cmemsLayerStates[layer] ||
                !isCmemsRenderedStepReady(cmemsLayerStates[layer]!, cmemsRequestedSteps[layer])
            );
        return false;
    });
    const captions: Partial<Record<NonNullable<HelixLayer>, string>> = {};
    for (const layer of activeWeatherLayers) {
        if (!layer) continue;
        if (layer === 'wind')
            captions[layer] = unavailableLayers.includes(layer)
                ? weather.windState?.loading
                    ? 'Loading wind data'
                    : 'Wind data unavailable'
                : `Model forecast · ${windValidTime}`;
        else if (layer === 'pressure')
            captions[layer] =
                weather.pressureTimeUnavailable ??
                (weather.pressureSource
                    ? `${pressureCaption}${pressureFollowsWind ? ' · Follows wind where coverage permits' : ''}`
                    : 'Pressure data unavailable');
        else if (layer === 'rain')
            captions[layer] = unavailableLayers.includes(layer)
                ? rainIsLoading
                    ? 'Loading rain imagery'
                    : 'Rain imagery unavailable'
                : `${currentRainFrame?.type === 'forecast' ? 'Forecast' : 'Radar'} · ${validTime(currentRainFrame?.timeMs)}`;
        else if (isCmemsLayer(layer)) {
            const state = cmemsLayerStates[layer];
            captions[layer] = unavailableLayers.includes(layer)
                ? state?.phase === 'error'
                    ? `${CMEMS_STATUS_LABELS[layer]} unavailable`
                    : isCmemsFeatureEnabled(layer)
                      ? `Verifying ${CMEMS_STATUS_LABELS[layer].toLowerCase()}`
                      : 'No verified forecast source available'
                : `Copernicus Marine · Selected step ${cmemsRequestedSteps[layer]} · Valid UTC unavailable`;
        } else captions[layer] = 'OpenWeather static tiles · Frame time and tile availability not exposed';
    }

    let content: React.ReactNode = null;
    if (showTimeline && activeWeatherLayers.length > 0) {
        if (activeLayer) {
            let frameIndex = 0;
            let totalFrames = 1;
            let frameLabel = 'Static tiles';
            let sublabel = 'OpenWeather · Frame time unavailable · Not controlled by this timeline';
            let isPlaying = false;
            let isLoading = false;
            let showInlineLoading = false;
            let framesReady: number | undefined;
            let nowIndex: number | undefined;
            let dualColor = false;
            let showRainRetry = false;
            // Radar needs the WAN, and on a boat "connected" usually means
            // connected to the vessel's own LAN with the uplink down — so a
            // bare "No Radar" leaves the skipper unable to tell a broken app
            // from a broken link. isOffline is a real WAN probe (see
            // services/internetProbe.ts), not navigator.onLine, which is
            // exactly the distinction that matters here.
            //
            // Read imperatively rather than subscribed: this component
            // early-returns above on `visible!`, so a hook here would be a
            // conditional-hook violation. The pill re-renders on every rain
            // state change and on tap, which is often enough for a label.
            const rainOffline = useUIStore.getState().isOffline;
            const forecastAccent = '#fbbf24';
            let onScrub = (_frame: number) => {};
            let onScrubStart: (() => void) | undefined;
            let onPlayToggle = () => {};
            let applyFrame: ((frame: number) => void) | undefined;

            if (activeLayer === 'pressure') {
                frameIndex = weather.forecastHour;
                totalFrames = weather.totalFrames;
                framesReady = weather.framesReady;
                isPlaying = weather.isPlaying;
                const pressureNowIndex = weather.pressureNowIdx;
                nowIndex = pressureNowIndex;
                const forecastHours = (frameIndex - pressureNowIndex) * weather.pressureFrameStepHours;
                // Names the provider and the model RUN. "Fallback" told the
                // skipper nothing about which forecast they were reading and
                // failed to credit Open-Meteo, whose CC-BY terms require it.
                const pressureSource =
                    'Model forecast · ' +
                    pressureSourceText(
                        pressureProvenance(weather.pressureSource, weather.pressureRefTime, weather.pressureClockMs),
                    );
                const validTime = pressureValidTimeText(weather.pressureValidTimeMs);
                if (!weather.pressureSource || !framesReady || weather.pressureValidTimeMs === null) {
                    const framePending =
                        !!weather.pressureSource &&
                        weather.pressureValidTimeMs === null &&
                        !weather.pressureTimeUnavailable;
                    frameLabel = weather.pressureLoading || framePending ? 'Loading…' : 'Unavailable';
                    sublabel = 'Mean sea-level pressure';
                    totalFrames = 1;
                    isLoading = !!weather.pressureLoading || framePending;
                    showInlineLoading = true;
                } else if (frameIndex === pressureNowIndex) {
                    // Nearest 2h GFS frame is a model prediction, not a live
                    // observation. Always expose its actual comparison clock.
                    frameLabel =
                        weather.pressureValidTimeMs != null &&
                        Math.abs(weather.pressureValidTimeMs - (weather.pressureClockMs ?? Date.now())) >
                            weather.pressureFrameStepHours * 1_800_000 + 60_000
                            ? 'Latest'
                            : 'Near now';
                    sublabel = `${pressureSource} · ${validTime}`;
                } else if (forecastHours > 0) {
                    frameLabel = `+${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = `${pressureSource} · ${validTime}`;
                } else {
                    frameLabel = `${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = `${pressureSource} · ${validTime}`;
                }
                if (weather.pressureError && weather.pressureSource) sublabel += ' · Saved data; refresh unavailable';
                if (weather.pressureSource) sublabel += pressureFetched;
                if (weather.pressureTimeUnavailable) {
                    frameLabel = 'Unavailable';
                    sublabel = `${weather.pressureTimeUnavailable} · ${pressureCaption}`;
                    totalFrames = 1;
                    isLoading = false;
                    showInlineLoading = true;
                } else if (pressureFollowsWind && weather.pressureSource) {
                    totalFrames = 1;
                    isPlaying = false;
                    sublabel += ' · Follows wind where coverage permits';
                }
                onScrub = weather.setForecastHour;
                onPlayToggle = () => weather.setIsPlaying(!weather.isPlaying);
                onScrubStart = () => weather.setIsPlaying(false);
                applyFrame = weather.applyFrame;
            } else if (activeLayer === 'wind') {
                const forecastHours = weather.windForecastHours ?? [];
                const usableGrid = isUsableWindGrid(weather.windState?.grid);

                if (weather.windState?.error) {
                    totalFrames = 1;
                    frameLabel = 'Unavailable';
                    sublabel = 'Wind data';
                } else if ((weather.windState?.loading && !usableGrid) || (usableGrid && !weather.windReady)) {
                    totalFrames = 1;
                    frameLabel = 'Loading…';
                    sublabel = 'Wind data';
                    isLoading = true;
                } else if (!usableGrid || forecastHours.length === 0) {
                    totalFrames = 1;
                    frameLabel = 'Unavailable';
                    sublabel = 'Wind data';
                } else {
                    const windNowIndex = weather.windNowIdx;
                    nowIndex = windNowIndex;
                    const roundedIndex = Math.round(weather.windHour);
                    const relativeHours = windHoursFromNow(forecastHours, roundedIndex, windNowIndex);
                    frameIndex = weather.windHour;
                    totalFrames = forecastHours.length;
                    if (roundedIndex === windNowIndex || relativeHours === 0) {
                        frameLabel = 'Near now';
                        sublabel = 'Model forecast';
                    } else if (relativeHours !== null) {
                        const displayHours = Number.isInteger(relativeHours)
                            ? relativeHours
                            : Number(relativeHours.toFixed(1));
                        frameLabel = displayHours > 0 ? `+${displayHours}h` : `${displayHours}h`;
                        sublabel = displayHours > 0 ? 'Forecast' : 'Past';
                    } else {
                        totalFrames = 1;
                        frameLabel = 'Unavailable';
                        sublabel = 'Wind data';
                    }
                    isPlaying = weather.windPlaying;
                    onScrub = weather.setWindHour;
                    onPlayToggle = () => weather.setWindPlaying(!weather.windPlaying);
                    onScrubStart = () => weather.setWindPlaying(false);
                    sublabel += ` · ${windValidTime}`;
                    // Close-in: what the streaks are showing, where. The boat's
                    // instruments are not a model forecast, nor at the model hour.
                    if (windCloseIn)
                        sublabel =
                            windCloseIn.source === 'boat'
                                ? `${windCloseIn.value} at the boat · Boat instruments${windCloseIn.stale ? ' · Stale' : ''}`
                                : `${windCloseIn.value} here · ${sublabel}`;
                }
            } else if (activeLayer === 'currents' && isCmemsFeatureEnabled('currents')) {
                frameIndex = weather.currentsHour;
                totalFrames = weather.currentsTotalHours;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.currents;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying currents';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const currentNowIndex = weather.currentsNowIdx;
                    nowIndex = currentNowIndex;
                    const relativeHours = selectedStep - currentNowIndex;
                    frameLabel =
                        relativeHours === 0 ? 'Now' : relativeHours > 0 ? `+${relativeHours}h` : `${relativeHours}h`;
                    sublabel = relativeHours === 0 ? 'Nowcast' : relativeHours > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.currentsPlaying;
                    onScrub = (frame: number) => weather.setCurrentsHour(Math.round(frame));
                    onPlayToggle = () => weather.setCurrentsPlaying(!weather.currentsPlaying);
                    onScrubStart = () => weather.setCurrentsPlaying(false);
                }
            } else if (activeLayer === 'waves' && isCmemsFeatureEnabled('waves')) {
                frameIndex = weather.wavesHour;
                totalFrames = weather.wavesTotalHours;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.waves;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying waves';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const wavesNowIndex = weather.wavesNowIdx;
                    nowIndex = wavesNowIndex;
                    const relativeHours = (selectedStep - wavesNowIndex) * 3;
                    frameLabel =
                        relativeHours === 0 ? 'Now' : relativeHours > 0 ? `+${relativeHours}h` : `${relativeHours}h`;
                    sublabel = relativeHours === 0 ? 'Nowcast' : relativeHours > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.wavesPlaying;
                    onScrub = (frame: number) => weather.setWavesHour(Math.round(frame));
                    onPlayToggle = () => weather.setWavesPlaying(!weather.wavesPlaying);
                    onScrubStart = () => weather.setWavesPlaying(false);
                }
            } else if (activeLayer === 'sst' && isCmemsFeatureEnabled('sst')) {
                frameIndex = weather.sstStep;
                totalFrames = weather.sstTotalSteps;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.sst;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying sea temperature';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const sstNowIndex = weather.sstNowIdx;
                    nowIndex = sstNowIndex;
                    const relativeDays = selectedStep - sstNowIndex;
                    frameLabel =
                        relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                    sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.sstPlaying;
                    onScrub = (frame: number) => weather.setSstStep(Math.round(frame));
                    onPlayToggle = () => weather.setSstPlaying(!weather.sstPlaying);
                    onScrubStart = () => weather.setSstPlaying(false);
                }
            } else if (activeLayer === 'chl' && isCmemsFeatureEnabled('chl')) {
                frameIndex = weather.chlStep;
                totalFrames = weather.chlTotalSteps;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.chl;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying chlorophyll';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const chlNowIndex = weather.chlNowIdx;
                    nowIndex = chlNowIndex;
                    const relativeDays = selectedStep - chlNowIndex;
                    frameLabel =
                        relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                    sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.chlPlaying;
                    onScrub = (frame: number) => weather.setChlStep(Math.round(frame));
                    onPlayToggle = () => weather.setChlPlaying(!weather.chlPlaying);
                    onScrubStart = () => weather.setChlPlaying(false);
                }
            } else if (activeLayer === 'seaice' && isCmemsFeatureEnabled('seaice')) {
                frameIndex = weather.seaiceStep;
                totalFrames = weather.seaiceTotalSteps;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.seaice;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying sea ice';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const seaIceNowIndex = weather.seaiceNowIdx;
                    nowIndex = seaIceNowIndex;
                    const relativeDays = selectedStep - seaIceNowIndex;
                    frameLabel =
                        relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                    sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.seaicePlaying;
                    onScrub = (frame: number) => weather.setSeaiceStep(Math.round(frame));
                    onPlayToggle = () => weather.setSeaicePlaying(!weather.seaicePlaying);
                    onScrubStart = () => weather.setSeaicePlaying(false);
                }
            } else if (activeLayer === 'mld' && isCmemsFeatureEnabled('mld')) {
                frameIndex = weather.mldStep;
                totalFrames = weather.mldTotalSteps;
                const selectedStep = Math.round(frameIndex);
                const state = cmemsLayerStates.mld;
                if (!state || !isCmemsRenderedStepReady(state, selectedStep)) {
                    frameLabel = state?.phase === 'error' ? 'Unavailable' : 'Loading…';
                    sublabel = state?.phase === 'error' ? 'Retry from alert' : 'Verifying mixed layer depth';
                    isLoading = state?.phase !== 'error';
                    showInlineLoading = true;
                    if (state?.phase === 'error') {
                        frameIndex = 0;
                        totalFrames = 1;
                    }
                } else {
                    const mldNowIndex = weather.mldNowIdx;
                    nowIndex = mldNowIndex;
                    const relativeDays = selectedStep - mldNowIndex;
                    frameLabel =
                        relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                    sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                    isPlaying = weather.mldPlaying;
                    onScrub = (frame: number) => weather.setMldStep(Math.round(frame));
                    onPlayToggle = () => weather.setMldPlaying(!weather.mldPlaying);
                    onScrubStart = () => weather.setMldPlaying(false);
                }
            } else if (activeLayer === 'rain') {
                if (rainIsLoading) {
                    isLoading = true;
                } else if (weather.rainReady && weather.rainFrameCount > 0) {
                    frameIndex = weather.rainFrameIndex;
                    totalFrames = weather.rainFrameCount;
                    nowIndex = weather.rainNowIdxRef.current;
                    const currentFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                    frameLabel = currentFrame?.label ?? '--';
                    sublabel = `${currentFrame?.type === 'forecast' ? 'Forecast' : 'Radar'} · ${validTime(currentFrame?.timeMs)}`;
                    isPlaying = weather.rainPlaying;
                    dualColor = true;
                    onScrub = weather.setRainFrameIndex;
                    onPlayToggle = () => weather.setRainPlaying(!weather.rainPlaying);
                    onScrubStart = () => weather.setRainPlaying(false);
                } else {
                    // The scrubber has nothing to scrub, so don't render one
                    // wearing the word "Retry" over dead handlers — render the
                    // retry itself.
                    showRainRetry = true;
                }
            } else if (isCmemsLayer(activeLayer)) {
                frameLabel = 'Unavailable';
                sublabel = 'No verified forecast source available';
                showInlineLoading = true;
            }

            if (isCmemsLayer(activeLayer) && !showInlineLoading) sublabel += ' · Valid UTC unavailable';
            content = showRainRetry ? (
                <button
                    type="button"
                    onClick={() => weather.retryRain()}
                    className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-left text-white active:bg-slate-800/80"
                    aria-label={
                        rainOffline
                            ? 'Rain radar unavailable — no internet connection. Tap to retry.'
                            : 'Rain radar unavailable — tap to retry'
                    }
                >
                    <span className="text-lg leading-none" aria-hidden="true">
                        {rainOffline ? '⚠' : '↻'}
                    </span>
                    <span className="leading-tight">
                        <span className="block text-sm font-bold">No Radar</span>
                        <span
                            className={`block text-[11px] font-semibold ${rainOffline ? 'text-amber-300' : 'text-cyan-300'}`}
                        >
                            {rainOffline ? 'No internet — tap to retry' : 'Tap to retry'}
                        </span>
                    </span>
                </button>
            ) : showInlineLoading || isLoading ? (
                <div
                    className="flex min-h-12 min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-white"
                    role={isLoading ? 'status' : 'alert'}
                    aria-live="polite"
                >
                    {isLoading && (
                        <span
                            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300"
                            aria-hidden="true"
                        />
                    )}
                    <span className="min-w-0">
                        <span className="block text-xs font-black">{isLoading ? 'Loading…' : frameLabel}</span>
                        <span className="block break-words text-[11px] font-semibold text-slate-300">{sublabel}</span>
                    </span>
                </div>
            ) : !isLoading ? (
                <ThalassaHelixControl
                    inline
                    legendVisible={false}
                    activeLayer={activeLayer}
                    frameIndex={frameIndex}
                    totalFrames={totalFrames}
                    frameLabel={frameLabel}
                    sublabel={sublabel}
                    isPlaying={isPlaying}
                    framesReady={framesReady}
                    embedded={embedded}
                    onScrub={onScrub}
                    onScrubStart={onScrubStart}
                    onPlayToggle={onPlayToggle}
                    applyFrame={applyFrame}
                    nowIndex={nowIndex}
                    dualColor={dualColor}
                    forecastAccent={forecastAccent}
                />
            ) : null;
        }
    }

    return (
        <>
            {showSurface && (
                <section
                    ref={autoHide.panelRef}
                    {...autoHide.interactionProps}
                    aria-label={hasExtraLegend ? 'Chart layer controls' : 'Weather controls'}
                    // On the chart the geometry lives in index.css
                    // (.thalassa-chart-controls-panel): it is measured from the
                    // Mapbox credits band and changes with the zoom rail's
                    // landscape position, which an inline style cannot follow.
                    // Since the panel took every chart layer (not only weather)
                    // it is the default surface, and at bottom 80px it lay on
                    // the Mapbox wordmark, the ⓘ, Locate and the zoom rail.
                    className={`${embedded ? '' : 'thalassa-chart-controls-panel '}absolute z-500 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/90 text-white shadow-lg backdrop-blur-xl`}
                    style={
                        embedded
                            ? {
                                  left: 'max(12px, env(safe-area-inset-left))',
                                  bottom: 12,
                                  width: 'min(420px, calc(100% - 24px))',
                                  maxHeight: 'calc(100% - 24px)',
                              }
                            : undefined
                    }
                >
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
                        <h2 className="min-w-0 text-xs font-bold">
                            {hasExtraLegend ? 'Chart layers' : 'Weather'}
                            {showTimeline && activeLayer && (
                                <span className="font-normal text-slate-400"> · {weatherLayerLabel(activeLayer)}</span>
                            )}
                        </h2>
                        {hideControlsButton}
                    </div>
                    {/* thalassa-chart-controls-panel-body: while the passage strip is
                        open, index.css caps the panel to the room the strip
                        leaves and lifts the timeline to the top of this body. */}
                    <div className="thalassa-chart-controls-panel-body min-h-0 space-y-2 overflow-y-auto overscroll-contain p-2">
                        {showTimeline && activeWeatherLayers.length > 1 && (
                            <div
                                role="group"
                                aria-label="Weather layer controls"
                                className="flex min-w-0 gap-1 overflow-x-auto pb-1"
                            >
                                {activeWeatherLayers.map((layer) => (
                                    <button
                                        key={layer}
                                        type="button"
                                        aria-label={`Control ${weatherLayerLabel(layer)}`}
                                        aria-pressed={activeLayer === layer}
                                        onClick={() => setSelectedLayer(layer)}
                                        className={`min-h-[44px] min-w-[44px] shrink-0 rounded-xl border px-3 py-2 text-xs font-bold ${activeLayer === layer ? 'border-sky-400/40 bg-sky-500/20 text-sky-200' : 'border-white/10 bg-white/5 text-slate-300'}`}
                                    >
                                        {weatherLayerLabel(layer)}
                                    </button>
                                ))}
                            </div>
                        )}
                        {showTimeline && activeLayer === 'wind' && (
                            <WindModelFieldSelector
                                model={weather.windModel}
                                onModelChange={weather.setWindModel}
                                embedded={embedded}
                                inline
                            />
                        )}
                        {content}
                        {showTimeline &&
                            activeWeatherLayers.includes('pressure') &&
                            hasWindLayer &&
                            activeLayer !== 'pressure' && (
                                <p
                                    role={weather.pressureTimeUnavailable ? 'alert' : undefined}
                                    className="px-2 text-[11px] leading-snug text-slate-300"
                                >
                                    Pressure:{' '}
                                    {weather.pressureTimeUnavailable ??
                                        `${pressureCaption} · Follows wind where coverage permits`}
                                </p>
                            )}
                        <LegendDock
                            inline
                            layers={activeWeatherLayers}
                            embedded={embedded}
                            captions={captions}
                            unavailableLayers={unavailableLayers}
                            pressureOverlay={weather.activeLayers.size > 1}
                            extraLegend={extraLegend}
                            extraLegendCount={extraLegendCount}
                        />
                    </div>
                </section>
            )}
            {/* RainViewer credit. It STAYS — their terms ask for the source to
                be named with a link, and they give us the radar for free — but
                a bare <a target="_blank"> navigated the WebView away from the
                app, so an accidental brush while scrubbing dumped the skipper
                out of the chart entirely (Shane 2026-08-22, "i have
                accidently pressed it twice"). On a navigation app that is a
                genuinely bad outcome, not just an annoyance.

                Now: openExternalUrl presents a dismissible sheet over the app
                (Done returns with chart state intact), the label is plain
                non-interactive text, and only the small ⓘ is a tap target.
                Since 2026-09-06 the credit sits top-centre under the basemap
                dropdown, clear of the chart's working area altogether. */}
            {showRainViewerAttribution && (
                <div
                    // Centred directly under the basemap dropdown (MapBaseSelector:
                    // top = inset + 8px, trigger h-12) — out of the main viewing
                    // area and nowhere near the scrubber's thumb path (Shane
                    // 2026-09-06). The same spot whether the controls are shown
                    // or hidden, so it never jumps.
                    className={`${CREDITS_STRIP_POSITION_CLASS} z-509 flex items-center gap-1 rounded-md bg-slate-950/70 px-2 py-1 backdrop-blur-xs`}
                    style={{ top: creditsStripTop(0) }}
                    // Cut out of the layer menu's scrim, like every licence credit.
                    data-map-credit
                >
                    <span className="text-[10px] font-semibold text-slate-300/80">Radar by RainViewer</span>
                    {/* A REAL anchor with a real href, so this is still a link
                        in the sense their terms ask for — copyable, and it
                        long-presses like one. The click is intercepted only so
                        it opens over the app instead of replacing it. */}
                    <a
                        href="https://www.rainviewer.com/"
                        onClick={(e) => {
                            e.preventDefault();
                            void openExternalUrl('https://www.rainviewer.com/');
                        }}
                        className="hit-target-44 flex h-4 w-4 items-center justify-center rounded-full text-[12px] font-bold text-slate-400/80 active:text-sky-300"
                        aria-label="Rain radar data by RainViewer"
                    >
                        ⓘ
                    </a>
                </div>
            )}
            {showRainForecastAttribution && (
                <div
                    className={`${CREDITS_STRIP_POSITION_CLASS} z-509 flex items-center gap-1 rounded-md bg-slate-950/70 px-2 py-1 backdrop-blur-xs`}
                    style={{ top: creditsStripTop(0) }}
                    data-testid="rain-forecast-credit"
                    data-map-credit
                >
                    <span className="text-[10px] font-semibold text-slate-300/80">Rain forecast by Rainbow.ai</span>
                    <a
                        href="https://rainbow.ai/"
                        onClick={(e) => {
                            e.preventDefault();
                            void openExternalUrl('https://rainbow.ai/');
                        }}
                        className="hit-target-44 flex h-4 w-4 items-center justify-center rounded-full text-[12px] font-bold text-slate-400/80 active:text-sky-300"
                        aria-label="Rain forecast imagery by Rainbow.ai"
                    >
                        ⓘ
                    </a>
                </div>
            )}
            {!surfaceAvailable ? null : controlsHidden ? (
                <button
                    ref={autoHide.triggerRef}
                    type="button"
                    onClick={autoHide.show}
                    data-testid="weather-status-pill"
                    data-tone={compactSummary.tone}
                    // Chart geometry: .thalassa-chart-controls-pill in index.css,
                    // which keeps it off the Mapbox wordmark (a licence credit)
                    // and, in short landscape, folds it to its glyphs on the
                    // credits row beside the wordmark. 12px text (the app's
                    // floor) on py-1 keeps two lines inside the 48px the CSS
                    // allows under the opened Mapbox credits.
                    className={`${embedded ? 'max-w-[calc(100%-88px)] ' : 'thalassa-chart-controls-pill '}absolute z-510 flex min-h-[44px] items-center gap-2 rounded-2xl border bg-slate-950/90 px-3 py-1 text-left text-[12px] text-slate-200 shadow-lg backdrop-blur-md active:scale-[0.98] ${compactSummary.tone === 'warning' ? 'border-amber-400/50' : 'border-sky-400/30'}`}
                    style={embedded ? { left: 'max(12px, env(safe-area-inset-left))', bottom: 12 } : undefined}
                    aria-label={hasExtraLegend ? 'Show layer controls' : 'Show weather controls'}
                    aria-describedby={summaryId}
                    title={compactSummary.accessibleText}
                >
                    {/* The app's layers glyph, not an ⓘ: folded to its glyph on a
                        landscape phone the pill sits on the credits row, beside
                        Mapbox's own ⓘ, and must not read as a second one. The
                        tone rides on its colour, a '!' badge and the pill's border. */}
                    <span aria-hidden="true" className="relative shrink-0">
                        <LayersGlyph
                            className={`h-5 w-5 ${compactSummary.tone === 'warning' ? 'text-amber-300' : 'text-sky-300'}`}
                        />
                        {compactSummary.tone === 'warning' && (
                            <span className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[12px] font-black leading-none text-slate-950">
                                !
                            </span>
                        )}
                    </span>
                    <span className="thalassa-chart-controls-pill-text min-w-0">
                        <span className="block truncate font-bold leading-snug">{compactSummary.primary}</span>
                        <span
                            className={`block truncate leading-snug ${compactSummary.tone === 'warning' ? 'text-amber-200' : 'text-slate-400'}`}
                        >
                            {compactSummary.secondary}
                        </span>
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-sky-300">
                        ▴
                    </span>
                    <span id={summaryId} className="sr-only">
                        {compactSummary.accessibleText}
                    </span>
                </button>
            ) : null}
        </>
    );
}
