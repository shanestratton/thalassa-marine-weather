import React from 'react';
import { WindIcon, WaveIcon, GaugeIcon, RainIcon, SunIcon, EyeIcon, StarIcon, TideCurveIcon, DropletIcon, ThermometerIcon, CloudIcon } from './Icons';

export const ALL_HERO_WIDGETS = [
    { id: 'wind', label: 'Wind Speed', icon: <WindIcon className="w-4 h-4" /> },
    { id: 'gust', label: 'Wind Gust', icon: <WindIcon className="w-4 h-4 text-orange-400" /> },
    { id: 'wave', label: 'Sea State', icon: <WaveIcon className="w-4 h-4" /> },
    { id: 'pressure', label: 'Barometer', icon: <GaugeIcon className="w-4 h-4" /> },
    { id: 'precip', label: 'Precipitation', icon: <RainIcon className="w-4 h-4" /> },
    { id: 'uv', label: 'UV Index', icon: <SunIcon className="w-4 h-4" /> },
    { id: 'visibility', label: 'Visibility', icon: <EyeIcon className="w-4 h-4" /> },
    { id: 'sunrise', label: 'Sun Mode', icon: <SunIcon className="w-4 h-4 text-orange-400" /> },
    { id: 'score', label: 'Boating Score', icon: <StarIcon className="w-4 h-4 text-yellow-400" /> },
];

export const ALL_DETAIL_WIDGETS = [
    { id: 'score', label: 'Condition Score', icon: <StarIcon className="w-4 h-4" /> },
    { id: 'tide', label: 'Tide Trend', icon: <TideCurveIcon className="w-4 h-4" /> },
    { id: 'pressure', label: 'Barometer', icon: <GaugeIcon className="w-4 h-4" /> },
    { id: 'humidity', label: 'Humidity', icon: <DropletIcon className="w-4 h-4" /> },
    { id: 'precip', label: 'Precipitation', icon: <RainIcon className="w-4 h-4" /> },
    { id: 'dewPoint', label: 'Dew Point', icon: <ThermometerIcon className="w-4 h-4" /> },
    { id: 'cloud', label: 'Cloud Cover', icon: <CloudIcon className="w-4 h-4" /> },
    { id: 'visibility', label: 'Visibility', icon: <EyeIcon className="w-4 h-4" /> },
    { id: 'chill', label: 'Wind Chill', icon: <ThermometerIcon className="w-4 h-4" /> },
    { id: 'swell', label: 'Swell Period', icon: <WaveIcon className="w-4 h-4" /> },
    { id: 'uv', label: 'UV Index', icon: <SunIcon className="w-4 h-4" /> },
    { id: 'waterTemp', label: 'Water Temp', icon: <ThermometerIcon className="w-4 h-4" /> },
];

export const ALL_ROW_WIDGETS = [
    { id: 'beaufort', label: 'Current Conditions', icon: <WindIcon className="w-4 h-4 text-sky-400" /> },

    { id: 'tides', label: 'Tide Graph', icon: <TideCurveIcon className="w-4 h-4 text-blue-400" /> },
    { id: 'sunMoon', label: 'Sun & Moon', icon: <SunIcon className="w-4 h-4 text-orange-400" /> },
    { id: 'vessel', label: 'Vessel Status', icon: <StarIcon className="w-4 h-4 text-emerald-400" /> },
    { id: 'advice', label: 'Captain\'s Log', icon: <StarIcon className="w-4 h-4 text-yellow-400" /> },
    { id: 'hourly', label: 'Hourly Forecast', icon: <StarIcon className="w-4 h-4 text-cyan-400" /> },
    { id: 'daily', label: 'Daily Forecast', icon: <StarIcon className="w-4 h-4 text-purple-400" /> },
    { id: 'map', label: 'Map Overview', icon: <StarIcon className="w-4 h-4 text-green-400" /> },
];
