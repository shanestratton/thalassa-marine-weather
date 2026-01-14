import { UnitPreferences } from '../types';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';

export const triggerHaptic = async (style: 'light' | 'medium' | 'heavy' = 'light') => {
    if (Capacitor.isNativePlatform()) {
        try {
            let impact = ImpactStyle.Light;
            if (style === 'medium') impact = ImpactStyle.Medium;
            if (style === 'heavy') impact = ImpactStyle.Heavy;
            await Haptics.impact({ style: impact });
        } catch (e) {
            // Ignore haptic errors
        }
    }
};

export const getSystemUnits = (): UnitPreferences => {
    // Default to Metric/International
    const defaults: UnitPreferences = {
        speed: 'kts',
        length: 'm',
        waveHeight: 'm',
        tideHeight: 'm',
        temp: 'C',
        distance: 'nm',
        visibility: 'nm',
        volume: 'l'
    };

    if (typeof navigator === 'undefined') return defaults;

    // Check for US Locale (Imperial Defaults)
    // We check both languages array and single property for broader support
    const languages = navigator.languages || [navigator.language || 'en'];
    const isUS = languages.some(l => l.toLowerCase() === 'en-us' || l.toLowerCase() === 'en-us');

    if (isUS) {
        return {
            speed: 'kts',
            length: 'ft',
            waveHeight: 'ft',
            tideHeight: 'ft',
            temp: 'F',
            distance: 'nm',
            visibility: 'nm',
            volume: 'gal'
        };
    }

    return defaults;
};
