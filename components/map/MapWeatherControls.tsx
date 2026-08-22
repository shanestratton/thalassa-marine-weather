/**
 * MapWeatherControls — chart weather timeline, legend, model picker and
 * declutter affordance.
 *
 * Kept separate from MapHub so the control surface can evolve and be tested
 * without entangling it with Mapbox lifecycle and route-planning state.
 */
import type React from 'react';
import type { useWeatherLayers } from './useWeatherLayers';
import type { WeatherLayer } from './mapConstants';
import { ThalassaHelixControl, LegendDock, type HelixLayer } from './ThalassaHelixControl';
import { WindModelFieldSelector } from './WindModelFieldSelector';
import { isCmemsFeatureEnabled } from './cmemsFeatureAvailability';
import { isUsableWindGrid, windHoursFromNow } from './windTimeAxis';
import type { CmemsLayerId } from './CmemsAttribution';
import type { CmemsLayerLoadState } from './useCmemsGridRefresh';
import { isCmemsRenderedStepReady } from './useCmemsPlayback';
import { useUIStore } from '../../stores/uiStore';
import { openExternalUrl } from '../../services/externalLinks';
import { pressureProvenance, pressureSourceText } from '../../services/weather/pressureProvenance';

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
}: MapWeatherControlsProps): React.ReactElement | null {
    if (!visible) return null;

    // Identify active weather layers (only scrubber-capable types).
    const weatherKeys: HelixLayer[] = [
        'pressure',
        'wind',
        'rain',
        'temperature',
        'clouds',
        // Currents + waves + SST + chl only get the scrubber when their CMEMS
        // pipeline is on. Under a raster fallback the tiles are static heatmaps.
        ...(isCmemsFeatureEnabled('currents') ? (['currents'] as HelixLayer[]) : []),
        ...(isCmemsFeatureEnabled('waves') ? (['waves'] as HelixLayer[]) : []),
        ...(isCmemsFeatureEnabled('sst') ? (['sst'] as HelixLayer[]) : []),
        ...(isCmemsFeatureEnabled('chl') ? (['chl'] as HelixLayer[]) : []),
        ...(isCmemsFeatureEnabled('seaice') ? (['seaice'] as HelixLayer[]) : []),
        ...(isCmemsFeatureEnabled('mld') ? (['mld'] as HelixLayer[]) : []),
    ];
    const activeWeatherLayers = weatherKeys.filter((key) =>
        key === 'wind'
            ? weather.activeLayers.has('wind' as WeatherLayer) || weather.activeLayers.has('velocity')
            : weather.activeLayers.has(key as WeatherLayer),
    );
    const showTimeline = !controlsHidden;
    const hasWindLayer = activeWeatherLayers.includes('wind');
    // Keep the wind controls available when Wind is paired with Rain. The
    // timeline intentionally changes to Rain in that combination, but the
    // wind-model selector remains available.
    const windFieldControls =
        showTimeline && hasWindLayer ? (
            <WindModelFieldSelector
                model={weather.windModel}
                onModelChange={weather.setWindModel}
                embedded={embedded}
            />
        ) : null;

    // Wind + rain share a deliberately-short rain timeline. Keep the wind
    // frame close to the selected radar frame rather than replaying a stale
    // wind field alongside current rain.
    const isWindRainCombo =
        activeWeatherLayers.length === 2 &&
        activeWeatherLayers.includes('wind') &&
        activeWeatherLayers.includes('rain');
    // Wind + pressure is the synoptic overlay: isobars ride the wind field
    // and FOLLOW the wind timeline (useWeatherLayers syncs the isobar frame
    // to windHour). One scrubber, the wind one — not the LegendDock.
    const isWindPressureCombo =
        activeWeatherLayers.length === 2 &&
        activeWeatherLayers.includes('wind') &&
        activeWeatherLayers.includes('pressure');
    const currentRainFrame = weather.unifiedFramesRef?.current?.[weather.rainFrameIndex];
    const showRainViewerAttribution =
        weather.activeLayers.has('rain') && weather.rainReady && currentRainFrame?.type === 'radar';
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
    const legendWeatherLayers = activeWeatherLayers.filter((layer) => {
        if (!isCmemsLayer(layer)) return true;
        const state = cmemsLayerStates[layer];
        return Boolean(state && isCmemsRenderedStepReady(state, cmemsRequestedSteps[layer]));
    });
    const stackedCmemsStatuses = activeWeatherLayers.filter(isCmemsLayer).flatMap((layer) => {
        const state = cmemsLayerStates[layer];
        return state && isCmemsRenderedStepReady(state, cmemsRequestedSteps[layer])
            ? []
            : [{ layer, phase: state?.phase === 'error' ? ('error' as const) : ('loading' as const) }];
    });

    let content: React.ReactNode = null;
    if (showTimeline && activeWeatherLayers.length >= 2 && !isWindRainCombo && !isWindPressureCombo) {
        // A requested CMEMS layer is not necessarily on the map yet. Keep its
        // legend out of the stacked dock until that exact step and generation
        // have passed verification and rendering.
        content = (
            <>
                <LegendDock layers={legendWeatherLayers} embedded={embedded} />
                {stackedCmemsStatuses.length > 0 && (
                    <div
                        className="absolute z-[501] min-w-44 rounded-xl border border-white/10 bg-slate-950/85 px-3 py-2 text-white shadow-lg backdrop-blur-xl"
                        style={{ left: 12, bottom: embedded ? 64 : 'calc(132px + env(safe-area-inset-bottom))' }}
                        role={stackedCmemsStatuses.some(({ phase }) => phase === 'error') ? 'alert' : 'status'}
                        aria-live="polite"
                    >
                        {stackedCmemsStatuses.map(({ layer, phase }) => (
                            <p key={layer} className="text-[11px] font-semibold">
                                <span className="font-black">{CMEMS_STATUS_LABELS[layer]}</span>
                                {phase === 'error' ? ' · Unavailable — Retry from alert' : ' · Loading…'}
                            </p>
                        ))}
                    </div>
                )}
            </>
        );
    } else if (showTimeline && isWindRainCombo) {
        if (weather.rainReady && !rainIsLoading && weather.rainFrameCount > 1) {
            const rainNow = weather.rainNowIdxRef.current;
            const currentFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
            const isForecast = currentFrame?.type === 'forecast';
            content = (
                <ThalassaHelixControl
                    activeLayer="wind"
                    frameIndex={weather.rainFrameIndex}
                    totalFrames={weather.rainFrameCount}
                    frameLabel={currentFrame?.label ?? '--'}
                    sublabel={isForecast ? 'Forecast' : 'Live'}
                    isPlaying={weather.rainPlaying}
                    embedded={embedded}
                    nowIndex={rainNow}
                    dualColor
                    forecastAccent="#fbbf24"
                    onScrub={(index: number) => {
                        weather.setRainFrameIndex(index);
                        const frame = weather.unifiedFramesRef.current[index];
                        if (!frame || weather.windForecastHours.length === 0) return;

                        const forecastHours = weather.windForecastHours;
                        const windNowIndex = weather.windNowIdx;
                        const rainNowIndex = weather.rainNowIdxRef.current;
                        // Rain frames are 10 minutes apart; choose the nearest
                        // available wind frame rather than assuming hourly data.
                        const targetForecastHour =
                            (forecastHours[windNowIndex] ?? 0) + ((index - rainNowIndex) * 10) / 60;
                        let nearestWindIndex = windNowIndex;
                        let nearestDistance = Infinity;
                        for (let candidate = 0; candidate < forecastHours.length; candidate += 1) {
                            const distance = Math.abs(forecastHours[candidate] - targetForecastHour);
                            if (distance < nearestDistance) {
                                nearestDistance = distance;
                                nearestWindIndex = candidate;
                            }
                        }
                        weather.setWindHour(nearestWindIndex);
                    }}
                    onScrubStart={() => weather.setRainPlaying(false)}
                    onPlayToggle={() => weather.setRainPlaying(!weather.rainPlaying)}
                />
            );
        }
        // If rain is not ready we intentionally fall through to a wind-only
        // timeline, exactly as the previous inlined renderer did.
    }

    if (showTimeline && content === null && activeWeatherLayers.length > 0) {
        // weatherKeys lists 'pressure' first, so in the wind+pressure combo
        // the wind timeline must be picked explicitly — pressure has no
        // scrubber of its own there, it follows windHour.
        const activeLayer = isWindPressureCombo ? 'wind' : activeWeatherLayers[0];
        if (activeLayer) {
            let frameIndex = 0;
            let totalFrames = 1;
            let frameLabel = 'Live';
            let sublabel = 'Live';
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
            // early-returns above on `!visible`, so a hook here would be a
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
                const pressureSource = pressureSourceText(
                    pressureProvenance(weather.pressureSource, weather.pressureRefTime),
                );
                if (frameIndex === pressureNowIndex) {
                    frameLabel = 'Now';
                    sublabel = `${pressureSource} · Current`;
                } else if (forecastHours > 0) {
                    frameLabel = `+${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = `${pressureSource} · Forecast`;
                } else {
                    frameLabel = `${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = `${pressureSource} · Past`;
                }
                onScrub = weather.setForecastHour;
                onPlayToggle = () => weather.setIsPlaying(!weather.isPlaying);
                onScrubStart = () => weather.setIsPlaying(false);
                applyFrame = weather.applyFrame;
            } else if (activeLayer === 'wind') {
                const forecastHours = weather.windForecastHours;
                const usableGrid = isUsableWindGrid(weather.windState.grid);

                if (weather.windState.error) {
                    totalFrames = 1;
                    frameLabel = 'Unavailable';
                    sublabel = 'Wind data';
                } else if ((weather.windState.loading && !usableGrid) || (usableGrid && !weather.windReady)) {
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
                    const roundedIndex = Math.round(weather.windHour);
                    const relativeHours = windHoursFromNow(forecastHours, roundedIndex, windNowIndex);
                    frameIndex = weather.windHour;
                    totalFrames = forecastHours.length;
                    if (roundedIndex === windNowIndex || relativeHours === 0) {
                        frameLabel = 'Now';
                        sublabel = 'Current';
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
                } else if (weather.rainReady && weather.rainFrameCount > 1) {
                    frameIndex = weather.rainFrameIndex;
                    totalFrames = weather.rainFrameCount;
                    nowIndex = weather.rainNowIdxRef.current;
                    const currentFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                    frameLabel = currentFrame?.label ?? '--';
                    sublabel = currentFrame?.type === 'forecast' ? 'Forecast' : 'Radar';
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
            }

            content = showRainRetry ? (
                <button
                    type="button"
                    onClick={() => weather.retryRain()}
                    className="absolute z-[500] flex min-h-12 min-w-40 items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-2 text-left text-white shadow-lg backdrop-blur-xl active:bg-slate-800/80"
                    style={{ left: 12, bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))' }}
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
            ) : showInlineLoading ? (
                <div
                    className="absolute z-[500] flex min-h-12 min-w-40 items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-2 text-white shadow-lg backdrop-blur-xl"
                    style={{ left: 12, bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))' }}
                    role={isLoading ? 'status' : 'alert'}
                    aria-live="polite"
                >
                    {isLoading && (
                        <span
                            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300"
                            aria-hidden="true"
                        />
                    )}
                    <span>
                        <span className="block text-xs font-black">{frameLabel}</span>
                        <span className="block text-[11px] font-semibold text-slate-300">{sublabel}</span>
                    </span>
                </div>
            ) : !isLoading ? (
                <ThalassaHelixControl
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
            {windFieldControls}
            {content}
            {/* RainViewer credit. It STAYS — their terms ask for the source to
                be named with a link, and they give us the radar for free — but
                a bare <a target="_blank"> navigated the WebView away from the
                app, so an accidental brush while scrubbing dumped the skipper
                out of the chart entirely (Shane 2026-08-22, "i have
                accidently pressed it twice"). On a navigation app that is a
                genuinely bad outcome, not just an annoyance.

                Now: openExternalUrl presents a dismissible sheet over the app
                (Done returns with chart state intact), the label is plain
                non-interactive text, and only the small ⓘ is a tap target —
                moved to the far corner, away from the scrubber thumb path. */}
            {showRainViewerAttribution && (
                <div
                    className="absolute right-2 z-[509] flex items-center gap-1 rounded-md bg-slate-950/70 px-2 py-1 backdrop-blur-sm"
                    style={{
                        bottom: controlsHidden
                            ? 'calc(84px + env(safe-area-inset-bottom))'
                            : 'calc(196px + env(safe-area-inset-bottom))',
                    }}
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
                        className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-slate-400/80 active:text-sky-300"
                        aria-label="Rain radar data by RainViewer"
                    >
                        ⓘ
                    </a>
                </div>
            )}
            {controlsHidden ? (
                <button
                    type="button"
                    onClick={() => onControlsHiddenChange(false)}
                    className="absolute left-1/2 -translate-x-1/2 z-[510] flex min-h-[44px] items-center gap-1.5 px-3 py-2 rounded-full bg-slate-900/85 border border-white/10 backdrop-blur-md shadow-lg text-[12px] font-bold text-slate-200"
                    style={{ bottom: 'calc(80px + env(safe-area-inset-bottom))' }}
                    aria-label="Show weather controls"
                >
                    <span className="text-sky-300 leading-none">▴</span> Weather controls
                </button>
            ) : (
                <button
                    type="button"
                    onClick={() => onControlsHiddenChange(true)}
                    // Same ROW as the scrubber (bottom 80px + inset), in the
                    // JMA column: the model row above is left-anchored at
                    // 12px and its five chips end at ~302px, so left-304
                    // parks this button directly under the last model chip,
                    // snug against the scrubber's right side (Shane
                    // 2026-08-21: "right up against the right hand side of
                    // the scrubber... or better still inline with the models
                    // directly above it (JMA)"). The min() keeps it on-screen
                    // if a narrow viewport ever compresses the rows.
                    className="absolute z-[510] flex h-12 w-12 items-center justify-center rounded-full bg-slate-900/85 border border-white/10 backdrop-blur-md shadow-lg text-slate-300"
                    style={{
                        left: 'min(304px, calc(100vw - 64px))',
                        bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))',
                    }}
                    aria-label="Hide weather controls"
                    title="Hide controls"
                >
                    <span className="text-[14px] leading-none">▾</span>
                </button>
            )}
        </>
    );
}
