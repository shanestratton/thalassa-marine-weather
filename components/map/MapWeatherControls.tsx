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
import { isCmemsCurrentsEnabled } from './useOceanCurrentParticleLayer';
import { isCmemsWavesEnabled } from './useOceanWaveParticleLayer';
import { isCmemsSstEnabled } from './useSstRasterLayer';
import { isCmemsChlEnabled } from './useChlRasterLayer';
import { isCmemsSeaIceEnabled } from './useSeaIceRasterLayer';
import { isCmemsMldEnabled } from './useMldRasterLayer';
import { isUsableWindGrid, windHoursFromNow } from './windTimeAxis';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

interface MapWeatherControlsProps {
    weather: WeatherControlsWeather;
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
        ...(isCmemsCurrentsEnabled() ? (['currents'] as HelixLayer[]) : []),
        ...(isCmemsWavesEnabled() ? (['waves'] as HelixLayer[]) : []),
        ...(isCmemsSstEnabled() ? (['sst'] as HelixLayer[]) : []),
        ...(isCmemsChlEnabled() ? (['chl'] as HelixLayer[]) : []),
        ...(isCmemsSeaIceEnabled() ? (['seaice'] as HelixLayer[]) : []),
        ...(isCmemsMldEnabled() ? (['mld'] as HelixLayer[]) : []),
    ];
    const activeWeatherLayers = weatherKeys.filter((key) =>
        key === 'wind'
            ? weather.activeLayers.has('wind' as WeatherLayer) || weather.activeLayers.has('velocity')
            : weather.activeLayers.has(key as WeatherLayer),
    );
    const showTimeline = !controlsHidden;

    // Wind + rain share a deliberately-short rain timeline. Keep the wind
    // frame close to the selected radar frame rather than replaying a stale
    // wind field alongside current rain.
    const isWindRainCombo =
        activeWeatherLayers.length === 2 &&
        activeWeatherLayers.includes('wind') &&
        activeWeatherLayers.includes('rain');
    const currentRainFrame = weather.unifiedFramesRef?.current?.[weather.rainFrameIndex];
    const showRainViewerAttribution =
        weather.activeLayers.has('rain') && weather.rainReady && currentRainFrame?.type === 'radar';

    let content: React.ReactNode = null;
    if (showTimeline && activeWeatherLayers.length >= 2 && !isWindRainCombo) {
        content = <LegendDock layers={activeWeatherLayers} embedded={embedded} />;
    } else if (showTimeline && isWindRainCombo) {
        if (weather.rainLoading) {
            content = (
                <ThalassaHelixControl
                    activeLayer="rain"
                    frameIndex={0}
                    totalFrames={1}
                    frameLabel="Loading..."
                    sublabel="Rain"
                    isPlaying={false}
                    isLoading
                    embedded={embedded}
                    onScrub={() => {}}
                    onPlayToggle={() => {}}
                />
            );
        } else if (weather.rainReady && weather.rainFrameCount > 1) {
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
        const activeLayer = activeWeatherLayers[0];
        if (activeLayer) {
            let frameIndex = 0;
            let totalFrames = 1;
            let frameLabel = 'Live';
            let sublabel = 'Live';
            let isPlaying = false;
            let isLoading = false;
            let framesReady: number | undefined;
            let nowIndex: number | undefined;
            let dualColor = false;
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
                const maxFrame = Math.max(0, totalFrames - 1);
                const pressureNowIndex = weather.pressureNowIdx;
                nowIndex = pressureNowIndex;
                const forecastHours = maxFrame > 0 ? ((frameIndex - pressureNowIndex) / maxFrame) * 12 : 0;
                if (frameIndex === pressureNowIndex) {
                    frameLabel = 'Now';
                    sublabel = 'Current';
                } else if (forecastHours > 0) {
                    frameLabel = `+${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = 'Forecast';
                } else {
                    frameLabel = `${forecastHours % 1 === 0 ? forecastHours : forecastHours.toFixed(1)}h`;
                    sublabel = 'Past';
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
                } else if (weather.windState.loading || (usableGrid && !weather.windReady)) {
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
            } else if (activeLayer === 'currents' && isCmemsCurrentsEnabled()) {
                frameIndex = weather.currentsHour;
                totalFrames = weather.currentsTotalHours;
                const currentNowIndex = weather.currentsNowIdx;
                nowIndex = currentNowIndex;
                const relativeHours = Math.round(frameIndex) - currentNowIndex;
                frameLabel =
                    relativeHours === 0 ? 'Now' : relativeHours > 0 ? `+${relativeHours}h` : `${relativeHours}h`;
                sublabel = relativeHours === 0 ? 'Nowcast' : relativeHours > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.currentsPlaying;
                onScrub = (frame: number) => weather.setCurrentsHour(Math.round(frame));
                onPlayToggle = () => weather.setCurrentsPlaying(!weather.currentsPlaying);
                onScrubStart = () => weather.setCurrentsPlaying(false);
            } else if (activeLayer === 'waves' && isCmemsWavesEnabled()) {
                frameIndex = weather.wavesHour;
                totalFrames = weather.wavesTotalHours;
                const wavesNowIndex = weather.wavesNowIdx;
                nowIndex = wavesNowIndex;
                const relativeHours = (Math.round(frameIndex) - wavesNowIndex) * 3;
                frameLabel =
                    relativeHours === 0 ? 'Now' : relativeHours > 0 ? `+${relativeHours}h` : `${relativeHours}h`;
                sublabel = relativeHours === 0 ? 'Nowcast' : relativeHours > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.wavesPlaying;
                onScrub = (frame: number) => weather.setWavesHour(Math.round(frame));
                onPlayToggle = () => weather.setWavesPlaying(!weather.wavesPlaying);
                onScrubStart = () => weather.setWavesPlaying(false);
            } else if (activeLayer === 'sst' && isCmemsSstEnabled()) {
                frameIndex = weather.sstStep;
                totalFrames = weather.sstTotalSteps;
                const sstNowIndex = weather.sstNowIdx;
                nowIndex = sstNowIndex;
                const relativeDays = Math.round(frameIndex) - sstNowIndex;
                frameLabel = relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.sstPlaying;
                onScrub = (frame: number) => weather.setSstStep(Math.round(frame));
                onPlayToggle = () => weather.setSstPlaying(!weather.sstPlaying);
                onScrubStart = () => weather.setSstPlaying(false);
            } else if (activeLayer === 'chl' && isCmemsChlEnabled()) {
                frameIndex = weather.chlStep;
                totalFrames = weather.chlTotalSteps;
                const chlNowIndex = weather.chlNowIdx;
                nowIndex = chlNowIndex;
                const relativeDays = Math.round(frameIndex) - chlNowIndex;
                frameLabel = relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.chlPlaying;
                onScrub = (frame: number) => weather.setChlStep(Math.round(frame));
                onPlayToggle = () => weather.setChlPlaying(!weather.chlPlaying);
                onScrubStart = () => weather.setChlPlaying(false);
            } else if (activeLayer === 'seaice' && isCmemsSeaIceEnabled()) {
                frameIndex = weather.seaiceStep;
                totalFrames = weather.seaiceTotalSteps;
                const seaIceNowIndex = weather.seaiceNowIdx;
                nowIndex = seaIceNowIndex;
                const relativeDays = Math.round(frameIndex) - seaIceNowIndex;
                frameLabel = relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.seaicePlaying;
                onScrub = (frame: number) => weather.setSeaiceStep(Math.round(frame));
                onPlayToggle = () => weather.setSeaicePlaying(!weather.seaicePlaying);
                onScrubStart = () => weather.setSeaicePlaying(false);
            } else if (activeLayer === 'mld' && isCmemsMldEnabled()) {
                frameIndex = weather.mldStep;
                totalFrames = weather.mldTotalSteps;
                const mldNowIndex = weather.mldNowIdx;
                nowIndex = mldNowIndex;
                const relativeDays = Math.round(frameIndex) - mldNowIndex;
                frameLabel = relativeDays === 0 ? 'Today' : relativeDays > 0 ? `+${relativeDays}d` : `${relativeDays}d`;
                sublabel = relativeDays === 0 ? 'Daily mean' : relativeDays > 0 ? 'Forecast' : 'Past';
                isPlaying = weather.mldPlaying;
                onScrub = (frame: number) => weather.setMldStep(Math.round(frame));
                onPlayToggle = () => weather.setMldPlaying(!weather.mldPlaying);
                onScrubStart = () => weather.setMldPlaying(false);
            } else if (activeLayer === 'rain') {
                if (weather.rainLoading) {
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
                    frameLabel = 'No Data';
                    sublabel = 'Retry';
                }
            }

            content = (
                <>
                    {activeLayer === 'wind' && (
                        <WindModelFieldSelector
                            model={weather.windModel}
                            onModelChange={weather.setWindModel}
                            loading={weather.windState.loading}
                            embedded={embedded}
                        />
                    )}
                    <ThalassaHelixControl
                        activeLayer={activeLayer}
                        frameIndex={frameIndex}
                        totalFrames={totalFrames}
                        frameLabel={frameLabel}
                        sublabel={sublabel}
                        isPlaying={isPlaying}
                        isLoading={isLoading}
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
                </>
            );
        }
    }

    return (
        <>
            {content}
            {showRainViewerAttribution && (
                <a
                    href="https://www.rainviewer.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="absolute right-4 z-[509] rounded-md bg-slate-950/70 px-2 py-1 text-[10px] font-semibold text-slate-300/80 backdrop-blur-sm"
                    style={{
                        bottom: controlsHidden
                            ? 'calc(84px + env(safe-area-inset-bottom))'
                            : 'calc(196px + env(safe-area-inset-bottom))',
                    }}
                    aria-label="Rain radar data by RainViewer"
                >
                    Radar by RainViewer
                </a>
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
                    className="absolute right-[16px] z-[510] flex h-12 w-12 items-center justify-center rounded-full bg-slate-900/85 border border-white/10 backdrop-blur-md shadow-lg text-slate-300"
                    style={{ bottom: 'calc(140px + env(safe-area-inset-bottom))' }}
                    aria-label="Hide weather controls"
                    title="Hide controls"
                >
                    <span className="text-[14px] leading-none">▾</span>
                </button>
            )}
        </>
    );
}
