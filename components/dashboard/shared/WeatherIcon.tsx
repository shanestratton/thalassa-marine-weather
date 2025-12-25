import React from 'react';
import { SunIcon, CloudIcon, RainIcon } from '../../Icons';

export const WeatherIcon = ({ condition, cloudCover, className }: { condition: string, cloudCover?: number, className?: string }) => {
    const c = condition ? condition.toLowerCase() : '';
    if (c.includes('rain')) return <RainIcon className={className} />;
    if (c.includes('storm') || c.includes('thunder')) return <RainIcon className={className} />;
    
    if (cloudCover !== undefined) {
        if (cloudCover > 60) return <CloudIcon className={className} />;
        if (cloudCover > 25) return <div className="relative"><SunIcon className={className} /><CloudIcon className={`absolute bottom-0 right-0 w-1/2 h-1/2 opacity-70`} /></div>; 
    }

    if (c.includes('cloud')) return <CloudIcon className={className} />;
    if (c.includes('fog')) return <CloudIcon className={className} />;
    return <SunIcon className={className} />;
}