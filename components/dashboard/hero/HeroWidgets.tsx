// Hero submodule helpers still exported through hero/index.ts.
//
// renderHeroWidget, renderHighLow, formatTemp and formatCondition were deleted
// 2026-09-26: nothing imported them, and they invented values where the data
// had none (high/low as air temperature ±2°, a missing temperature as 0°, a
// missing condition as 'Clear', a missing wind direction as 'VAR'). The live
// grid is components/dashboard/HeroWidgets.tsx; don't revive these.

// --- STATIC WIDGET CLASS ---
export const STATIC_WIDGET_CLASS =
    'flex-1 min-w-[32%] md:min-w-[30%] bg-white/6 border border-white/10 rounded-xl p-2 md:p-4 relative flex flex-col justify-center min-h-[90px] md:min-h-[100px] shrink-0';

// --- SOURCE COLOR HELPER ---
export const getSourceIndicatorColor = (sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'): string => {
    switch (sourceColor) {
        case 'emerald':
            return 'bg-emerald-500'; // Buoy
        case 'sky':
            return 'bg-sky-500'; // WeatherKit
        case 'amber':
            return 'bg-amber-500'; // StormGlass
        default:
            return 'bg-gray-500'; // Fallback
    }
};
