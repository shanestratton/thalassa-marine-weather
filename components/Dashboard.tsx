
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { GripIcon, StarIcon, AlertTriangleIcon, BugIcon, ClockIcon } from './Icons';
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { generateMarineAudioBriefing, isGeminiConfigured } from '../services/geminiService';
import { 
    expandCompassDirection, expandForSpeech, getSkipperLockerItems, 
    convertTemp, convertSpeed, convertLength, convertPrecip, convertDistance, calculateWindChill, triggerHaptic, checkForecastThresholds
} from '../utils';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { useUI } from '../context/UIContext';
import { Clock } from './Clock';

import { HeroSection } from './dashboard/Hero';
import { AlertsBanner } from './dashboard/WeatherGrid';
import { WidgetRenderer, DashboardWidgetContext } from './WidgetRenderer';

const SortableRow: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 50 : 1, position: 'relative' as 'relative', opacity: isDragging ? 0.8 : 1 };
    
    useEffect(() => {
        if(isDragging) triggerHaptic('light');
    }, [isDragging]);

    return (
        <div ref={setNodeRef} style={style} className="group relative mb-6 px-2 md:px-0">
            <div {...attributes} {...listeners} className="absolute top-1 right-2 z-50 p-2 text-white/10 hover:text-white/50 cursor-grab active:cursor-grabbing transition-colors rounded-full hover:bg-white/5" title="Drag to reorder"><GripIcon className="w-5 h-5" /></div>
            {children}
        </div>
    );
};

// Helper to decode raw PCM (Gemini format) to AudioBuffer
const decodePCM = (buffer: ArrayBuffer, ctx: AudioContext): AudioBuffer => {
    const pcm16 = new Int16Array(buffer);
    const channelCount = 1;
    const sampleRate = 24000;
    const frameCount = pcm16.length;
    
    const audioBuffer = ctx.createBuffer(channelCount, frameCount, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    
    for (let i = 0; i < frameCount; i++) {
        channelData[i] = pcm16[i] / 32768.0;
    }
    
    return audioBuffer;
};

interface DashboardProps {
    onOpenMap: () => void;
    onTriggerUpgrade: () => void;
    favorites: string[];
    displayTitle: string;
    timeZone?: string;
    utcOffset?: number;
    timeDisplaySetting: string;
    onToggleFavorite: () => void;
    isRefreshing?: boolean;
    isNightMode: boolean;
    isMobileLandscape?: boolean;
}

export const Dashboard: React.FC<DashboardProps> = React.memo(({ 
    onOpenMap, 
    onTriggerUpgrade, 
    favorites, 
    displayTitle,
    timeZone,
    utcOffset,
    timeDisplaySetting,
    onToggleFavorite,
    isNightMode,
    isMobileLandscape
}) => {
  // Optimization: De-coupled hooks
  const { weatherData: data, backgroundUpdating, nextUpdate } = useWeather();
  const { settings, updateSettings } = useSettings();
  const { setPage } = useUI();
  
  const isSystemHealthy = isGeminiConfigured();
  
  if (!data) return null;

  const { units, vessel, isPro } = settings;
  const { current, forecast = [], tides = [], hourly: rawHourly = [], boatingAdvice, alerts = [], isLandlocked, tideHourly = [] } = data;
  
  const [chartView, setChartView] = useState<'hourly' | 'daily'>('hourly');
  const [hiddenSeries, setHiddenSeries] = useState<Record<string, boolean>>({ wind: false, gust: false, wave: isLandlocked || false, tide: isLandlocked || false });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isAudioPreloading, setIsAudioPreloading] = useState(false);
  const [preloadedAudio, setPreloadedAudio] = useState<ArrayBuffer | null>(null);
  const [audioPreloadAttempted, setAudioPreloadAttempted] = useState(false); 
  
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Optimization: Track advice hash to prevent unnecessary preloading checks
  const processedAdviceRef = useRef<string | null>(null);
  
  const hourly = useMemo(() => rawHourly || [], [rawHourly]);
  const userThresholdAlerts = useMemo(() => 
      checkForecastThresholds(hourly, forecast, settings.notifications), 
  [hourly, forecast, settings.notifications]);

  const allAlerts = useMemo(() => [...(alerts || []), ...userThresholdAlerts], [alerts, userThresholdAlerts]);

  // Dashboard Layout (Beaufort -> Details -> Tides -> Advice -> Charts -> Map)
  const heroWidgets = settings.heroWidgets || ['wind', 'wave', 'pressure']; // Though hero widgets are handled in Hero.tsx, we keep ref here if needed for sync
  const detailsWidgets = settings.detailsWidgets || []; // Similarly for details

  // We are sorting ROWS here, distinct from Hero/Detail widgets
  const [rowOrder, setRowOrder] = useState(['beaufort', 'details', 'tides', 'advice', 'charts', 'map']);
  
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } })
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (active && over && active.id !== over.id) {
        setRowOrder((items) => {
            const oldIndex = items.indexOf(active.id);
            const newIndex = items.indexOf(over.id);
            return arrayMove(items, oldIndex, newIndex);
        });
    }
  };

  // Audio Handler
  const handleAudioBroadcast = async () => {
      if (isSpeaking) {
          if (sourceRef.current) {
              sourceRef.current.stop();
              sourceRef.current = null;
          }
          setIsSpeaking(false);
          return;
      }

      if (preloadedAudio) {
          playAudio(preloadedAudio);
          return;
      }

      if (!isSystemHealthy) {
          alert("Audio system offline. Check API key.");
          return;
      }

      setIsBuffering(true);
      try {
          const script = `
              Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, Captain. 
              Here is the briefing for ${expandForSpeech(data.locationName)}.
              
              Current conditions: ${expandForSpeech(current.condition)}. 
              Wind is ${current.windSpeed} knots from the ${expandCompassDirection(current.windDirection)}.
              ${!isLandlocked ? `Sea state is ${current.waveHeight} feet.` : ''}
              
              ${expandForSpeech(boatingAdvice || '')}
              
              ${forecast.length > 0 ? `Forecast for tomorrow: ${expandForSpeech(forecast[1].condition)} with a high of ${forecast[1].highTemp} degrees.` : ''}
              
              End of report.
                  `;
          
          const audioData = await generateMarineAudioBriefing(script);
          playAudio(audioData);
      } catch (e: any) {
          const errStr = JSON.stringify(e);
          const isQuota = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');
          
          if (isQuota) {
              console.warn("Audio Broadcast: Quota Limit Reached");
              alert("Audio briefing unavailable: Daily limit reached.");
          } else {
              console.error("Audio Broadcast Error:", e);
              alert("Unable to generate audio briefing at this time.");
          }
          setIsBuffering(false);
      }
  };

  const playAudio = async (buffer: ArrayBuffer) => {
      if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      }
      const ctx = audioCtxRef.current;
      
      try {
          if (ctx.state === 'suspended') await ctx.resume();
          const decoded = decodePCM(buffer, ctx);
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.connect(ctx.destination);
          source.onended = () => setIsSpeaking(false);
          source.start();
          sourceRef.current = source;
          setIsSpeaking(true);
          setIsBuffering(false);
      } catch (e) {
          console.error("Playback error", e);
          setIsBuffering(false);
      }
  };

  const shareReport = () => {
      if (navigator.share) {
          navigator.share({
              title: `Thalassa Report: ${data.locationName}`,
              text: `Current Conditions: ${current.condition}, ${current.windSpeed}kts Wind. \n${boatingAdvice}`,
              url: window.location.href
          });
      }
  };

  const chartData = useMemo(() => {
        if (chartView === 'hourly') {
            return hourly.map(h => ({
                time: h.time,
                wind: convertSpeed(h.windSpeed, units.speed) || 0,
                gust: convertSpeed(h.windGust, units.speed) || 0,
                wave: convertLength(h.waveHeight, units.length) || 0,
                tide: h.tideHeight !== undefined ? convertLength(h.tideHeight, units.tideHeight || 'm') : undefined
            }));
        } else {
            return forecast.map(d => ({
                time: d.day.substring(0, 3),
                wind: convertSpeed(d.windSpeed, units.speed) || 0,
                gust: convertSpeed(d.windGust, units.speed) || 0,
                wave: convertLength(d.waveHeight, units.length) || 0
            }));
        }
  }, [chartView, hourly, forecast, units, isLandlocked]);

  const lockerItems = useMemo(() => getSkipperLockerItems(current, units.temp, isLandlocked, data.locationName), [current, units.temp, isLandlocked, data.locationName]);

  const toggleChartSeries = (key: string) => setHiddenSeries(prev => ({ ...prev, [key]: !prev[key] }));

  // Optimization: State reset effect depends only on advice string changing
  useEffect(() => {
      if (boatingAdvice && boatingAdvice !== processedAdviceRef.current) {
          setPreloadedAudio(null);
          setAudioPreloadAttempted(false);
          processedAdviceRef.current = boatingAdvice;
      }
  }, [boatingAdvice]);

  // Optimization: Preload logic decoupled from massive dependency array
  useEffect(() => {
      // Only run if conditions met AND we haven't tried this session
      if (isPro && !preloadedAudio && !isAudioPreloading && !audioPreloadAttempted && isSystemHealthy && boatingAdvice) {
          const preload = async () => {
              setIsAudioPreloading(true);
              try {
                  const script = `
                      Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, Captain. 
                      Here is the briefing for ${expandForSpeech(data.locationName)}.
                      
                      Current conditions: ${expandForSpeech(current.condition)}. 
                      Wind is ${current.windSpeed} knots from the ${expandCompassDirection(current.windDirection)}.
                      ${!isLandlocked ? `Sea state is ${current.waveHeight} feet.` : ''}
                      
                      ${expandForSpeech(boatingAdvice || '')}
                      
                      ${forecast.length > 0 ? `Forecast for tomorrow: ${expandForSpeech(forecast[1].condition)} with a high of ${forecast[1].highTemp} degrees.` : ''}
                      
                      End of report.
                  `;
                  
                  const audioData = await generateMarineAudioBriefing(script);
                  setPreloadedAudio(audioData);
              } catch (e: any) {
                  // Handle Quota Exhaustion (429) silently or with warn
                  const errMsg = e.message || JSON.stringify(e);
                  if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                      console.warn("Audio Preload: Quota Limit Reached (Silent Fail)");
                  } else {
                      console.warn("Audio Preload Failed (Silent Fail)");
                  }
                  // Do NOT retry automatically if it fails once for this advice session
              } finally {
                  setIsAudioPreloading(false);
                  setAudioPreloadAttempted(true); // Mark as attempted to prevent infinite loop
              }
          };
          
          // Small delay to ensure UI renders first
          const t = setTimeout(preload, 1000);
          return () => clearTimeout(t);
      }
  }, [isPro, isSystemHealthy, boatingAdvice, preloadedAudio, isAudioPreloading, audioPreloadAttempted]); // Minimal dependencies

  const widgetContext: DashboardWidgetContext = useMemo(() => ({
      current,
      forecast,
      hourly,
      tides,
      tideHourly,
      boatingAdvice,
      lockerItems,
      locationName: data.locationName,
      timeZone: data.timeZone,
      modelUsed: data.modelUsed,
      isLandlocked,
      units,
      vessel,
      isPro,
      chartData,
      chartView,
      hiddenSeries,
      isSpeaking,
      isBuffering,
      isAudioPreloading,
      isNightMode,
      backgroundUpdating,
      setChartView,
      toggleChartSeries,
      handleAudioBroadcast,
      shareReport,
      onTriggerUpgrade,
      onOpenMap,
      settings, 
      weatherData: data 
  }), [
      current, forecast, hourly, tides, tideHourly, boatingAdvice, lockerItems, data.locationName, 
      data.timeZone, data.modelUsed, isLandlocked, units, vessel, isPro, chartData, chartView, 
      hiddenSeries, isSpeaking, isBuffering, isAudioPreloading, isNightMode, backgroundUpdating,
      settings, data
  ]);

  return (
    <div className="w-full max-w-7xl mx-auto pb-32 px-0 md:px-6">
        
        {/* Top Section: Date/Time Only (Removed Location Header) */}
        <div className="mb-6 space-y-4 px-2 md:px-0 pt-2">
            
            <div className="flex justify-end items-center px-1">
                <div className="flex flex-col items-end">
                    <Clock 
                        timeZone={timeDisplaySetting === 'location' ? timeZone : undefined} 
                        utcOffset={timeDisplaySetting === 'location' ? utcOffset : undefined} 
                        format="full"
                        className="text-lg md:text-xl font-sans font-bold tracking-tight tabular-nums text-sky-400" 
                    />
                    <span className="text-[10px] text-gray-500 uppercase tracking-widest">
                        {timeDisplaySetting === 'device' ? 'Device Time' : 'Location Time'}
                    </span>
                </div>
            </div>

            <AlertsBanner alerts={allAlerts} />

            <HeroSection 
                current={current} 
                todayForecast={forecast[0]} 
                units={units} 
                generatedAt={data.generatedAt} 
                vessel={vessel}
                modelUsed={data.modelUsed}
                groundingSource={data.groundingSource}
                isLandlocked={isLandlocked}
                locationName={data.locationName}
                nextUpdate={nextUpdate}
            />
        </div>

        {/* Sortable Content Rows */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={rowOrder} strategy={verticalListSortingStrategy}>
                {rowOrder.map(id => (
                    <SortableRow key={id} id={id}>
                        <WidgetRenderer id={id} context={widgetContext} />
                    </SortableRow>
                ))}
            </SortableContext>
        </DndContext>

        <div className="text-center mt-12 mb-8 opacity-40">
            <div className="flex justify-center items-center gap-2 mb-2">
                <BugIcon className="w-4 h-4 text-gray-500" />
                <span className="text-[10px] font-mono text-gray-500 uppercase">System Active • {data.modelUsed}</span>
            </div>
            <p className="text-[9px] text-gray-600 max-w-md mx-auto">
                Maritime weather data is subject to rapid change. Not for navigation.
            </p>
        </div>
    </div>
  );
});
