import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { canRefreshRainForecast } from '../utils/offlineAuthority';

describe('single offline authority', () => {
    it('prevents rain refreshes while the app-level reachability probe says offline', () => {
        expect(canRefreshRainForecast(false, true, false)).toBe(false);
        expect(canRefreshRainForecast(false, false, false)).toBe(true);
        expect(canRefreshRainForecast(true, false, false)).toBe(false);
        expect(canRefreshRainForecast(false, false, true)).toBe(false);
    });

    it('does not bypass the probe with navigator.onLine in weather paths', () => {
        const executable = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const dashboard = executable(readFileSync('components/Dashboard.tsx', 'utf8'));
        const context = executable(readFileSync('context/WeatherContext.tsx', 'utf8'));
        const orchestrator = executable(readFileSync('services/WeatherOrchestrator.ts', 'utf8'));

        expect(dashboard).not.toContain('navigator.onLine');
        expect(context).not.toContain('navigator.onLine');
        expect(orchestrator).not.toContain('navigator.onLine');
        expect(context).toContain('useUIStore.getState().isOffline');
        expect(orchestrator).toContain('this.cb.getIsOffline()');
    });

    it('does not create periodic refresh or live-overlay timers while the probe says offline', () => {
        const source = readFileSync('context/WeatherContext.tsx', 'utf8');

        expect(source).toMatch(/SMART REFRESH TIMER[\s\S]*?if \(isOffline\) return;[\s\S]*?setInterval/);
        expect(source).toMatch(/LIVE OVERLAY[\s\S]*?if \(isOffline\) return;[\s\S]*?setInterval/);
        expect(source).not.toContain("window.addEventListener('online', handleOnline)");
    });
});
