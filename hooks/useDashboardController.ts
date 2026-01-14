
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { useUI } from '../context/UIContext';
import { generateTacticalAdvice, getSkipperLockerItems } from '../utils/advisory';
import { MarineWeatherReport } from '../types';

export const useDashboardController = (
    viewMode: 'overview' | 'details' = 'overview'
) => {
    const { weatherData: data, refreshData, loading } = useWeather();
    const { settings } = useSettings();
    const { setPage } = useUI();
    const { isPro } = settings;

    // View State
    const [chartView, setChartView] = useState<'hourly' | 'tide'>('hourly');
    const [view, setView] = useState<'forecast' | 'charts'>('forecast');

    // Audio State
    const [isAudioPreloading, setIsAudioPreloading] = useState(false);
    const [preloadedAudio, setPreloadedAudio] = useState<ArrayBuffer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioSource, setAudioSource] = useState<AudioBufferSourceNode | null>(null);
    const [audioPreloadAttempted, setAudioPreloadAttempted] = useState(false);

    // Refs
    const processedAdviceRef = useRef<string | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);

    // RESET SCROLL ON MOUNT
    useEffect(() => {
        const scrollContainer = document.getElementById('app-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    }, [viewMode]);

    // DERIVED DATA
    const current = data?.current;
    const isLandlocked = data?.isLandlocked || false;
    const vessel = settings.vessel;

    // 1. Dynamic Advice
    const boatingAdvice = useMemo(() => {
        if (!current || !data) return null;
        return generateTacticalAdvice(
            current,
            isLandlocked,
            data.locationName,
            vessel,
            data.tides || [],
            current.sunset
        );
    }, [current, isLandlocked, data, vessel]);

    // 2. Locker Items
    const lockerItems = useMemo(() => {
        if (!current) return [];
        return getSkipperLockerItems(current, settings.units.temp, isLandlocked, data?.locationName || '');
    }, [current, settings.units.temp, isLandlocked, data]);

    // 3. Hourly Data (Timezone Adjusted)
    const hourly = useMemo(() => {
        if (!data?.hourly) return [];
        return data.hourly.map((h: any) => ({
            ...h,
            time: new Date(new Date(h.time).getTime() + (data.utcOffset || 0) * 3600000).toISOString() // Visual shift only
        }));
    }, [data?.hourly, data?.utcOffset]);

    // AUDIO LOGIC (Simplified for Controller)

    // Helper: Decode PCM
    const decodePCM = async (buffer: ArrayBuffer, ctx: AudioContext): Promise<AudioBuffer> => {
        const float32Array = new Float32Array(buffer);
        const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);
        return audioBuffer;
    };

    const playAudio = useCallback(async (buffer: ArrayBuffer) => {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        const ctx = audioContextRef.current;
        if (ctx.state === 'suspended') await ctx.resume();

        try {
            const audioBuffer = await decodePCM(buffer, ctx);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.onended = () => setIsPlaying(false);
            source.start(0);
            setAudioSource(source);
            setIsPlaying(true);
        } catch (e) {
            console.error("Audio Decode/Play Err:", e);
            setIsPlaying(false);
        }
    }, []);

    const stopAudio = useCallback(() => {
        if (audioSource) {
            audioSource.stop();
            setIsPlaying(false);
        }
    }, [audioSource]);

    const speakNativeFallback = useCallback((text: string) => {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.onend = () => setIsPlaying(false);
        utterance.onerror = () => setIsPlaying(false);
        setIsPlaying(true);
        window.speechSynthesis.speak(utterance);
    }, []);

    const handleAudioBroadcast = useCallback(async () => {
        if (isPlaying) {
            if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
            stopAudio();
            setIsPlaying(false);
            return;
        }

        if (preloadedAudio) {
            await playAudio(preloadedAudio);
            return;
        }

        // Native Fallback if no audio or offline
        if (boatingAdvice) {
            // Strip markdown for speech
            const cleanText = boatingAdvice.replace(/\*\*/g, '').replace(/__/, '');
            speakNativeFallback(cleanText);
        }
    }, [isPlaying, preloadedAudio, boatingAdvice, playAudio, stopAudio, speakNativeFallback]);


    // SHARING
    const shareReport = async () => {
        if (!data || !current) return;
        const text = `🌊 Marine Weather Report for ${data.locationName}\n` +
            `💨 Wind: ${(current.windSpeed || 0).toFixed(1)} kts\n` +
            `🌊 Swell: ${current.waveHeight?.toFixed(1) || '--'}m\n` +
            `🌡 Temp: ${(current.airTemperature || 0).toFixed(1)}°\n` +
            `Generated by Thalassa`;

        try {
            if (navigator.share) {
                await navigator.share({ title: 'Thalassa Report', text });
            } else {
                await navigator.clipboard.writeText(text);
                alert("Report copied to clipboard!");
            }
        } catch (e) { console.warn("Share failed", e); }
    };


    return {
        // Data
        data,
        current,
        hourly,
        boatingAdvice,
        lockerItems,
        isLandlocked: data?.isLandlocked || false,
        isPro,
        settings,
        vessel,

        // UI State
        chartView, setChartView,
        view, setView,

        // Audio State
        isPlaying,
        isAudioPreloading,
        hasPreloadedAudio: !!preloadedAudio,

        // Actions
        refreshData,
        handleAudioBroadcast,
        shareReport,
        setPage, // for 'Open Map' actions

        // Calculated
        refreshInterval: 300000, // Fixed 5m for now or hook from settings
    };
};
