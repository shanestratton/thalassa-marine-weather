import { VesselProfile, HourlyForecast } from '../types';

export const calculateHullSpeed = (lwl: number): number => {
    return 1.34 * Math.sqrt(lwl);
};

export const calculateMCR = (disp: number, loa: number, beam: number): number => {
    return disp / (0.65 * (0.7 * loa + 0.3 * loa) * Math.pow(beam, 1.33));
};

export const calculateCSF = (disp: number, beam: number): number => {
    return beam / Math.pow(disp / 64, 0.333);
};

export const calculateDLR = (disp: number, lwl: number): number => {
    const longTons = disp / 2240;
    return longTons / Math.pow(0.01 * lwl, 3);
};

export const getTideStatus = (idx: number, hourly: HourlyForecast[]): 'rising' | 'falling' | 'high' | 'low' | 'steady' => {
    if (!hourly || idx === 0 || idx >= hourly.length - 1) return 'steady';
    const prev = hourly[idx - 1].tideHeight || 0;
    const curr = hourly[idx].tideHeight || 0;
    const next = hourly[idx + 1].tideHeight || 0;
    if (curr > prev && curr > next) return 'high';
    if (curr < prev && curr < next) return 'low';
    if (curr > prev) return 'rising';
    if (curr < prev) return 'falling';
    return 'steady';
};

export const calculateDailyScore = (wind: number, wave: number, vessel?: VesselProfile): number => {
    let score = 100;
    const maxWind = vessel?.maxWindSpeed || 25;
    const maxWave = vessel?.maxWaveHeight || 8;
    if (wind > maxWind) score -= 80;
    else if (wind > maxWind * 0.8) score -= 40;
    else if (wind > maxWind * 0.6) score -= 20;
    else if (wind < 5 && vessel?.type === 'sail') score -= 30;
    if (wave > maxWave) score -= 90;
    else if (wave > maxWave * 0.7) score -= 50;
    else if (wave > maxWave * 0.5) score -= 20;
    return Math.max(0, Math.min(100, score));
};

export const getSailingScoreColor = (score: number): string => {
    if (score >= 80) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
    if (score >= 60) return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
    if (score >= 40) return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
    return 'bg-red-500/20 text-red-400 border-red-500/50';
};

export const getSailingConditionText = (score: number): string => {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Poor';
};

export const getBeaufort = (knots: number | null | undefined) => {
    if (knots === null || knots === undefined) return { force: 0, desc: "Unknown", sea: "Calm" };
    if (knots < 1) return { force: 0, desc: "Calm", sea: "Sea like a mirror" };
    if (knots < 4) return { force: 1, desc: "Light Air", sea: "Ripples but no foam crests" };
    if (knots < 7) return { force: 2, desc: "Light Breeze", sea: "Small wavelets, glassy crests" };
    if (knots < 11) return { force: 3, desc: "Gentle Breeze", sea: "Large wavelets, crests break" };
    if (knots < 17) return { force: 4, desc: "Moderate Breeze", sea: "Small waves, becoming longer" };
    if (knots < 22) return { force: 5, desc: "Fresh Breeze", sea: "Moderate waves, many whitecaps" };
    if (knots < 28) return { force: 6, desc: "Strong Breeze", sea: "Large waves, foam crests everywhere" };
    if (knots < 34) return { force: 7, desc: "Near Gale", sea: "Sea heaps up, white foam streaks" };
    if (knots < 41) return { force: 8, desc: "Gale", sea: "Moderately high waves, spindrift" };
    if (knots < 48) return { force: 9, desc: "Strong Gale", sea: "High waves, dense foam streaks" };
    if (knots < 56) return { force: 10, desc: "Storm", sea: "Very high waves, visibility reduced" };
    if (knots < 64) return { force: 11, desc: "Violent Storm", sea: "Exceptionally high waves" };
    return { force: 12, desc: "Hurricane", sea: "Air filled with foam and spray" };
};
