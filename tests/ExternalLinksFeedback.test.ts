import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    betaFeedbackUrl,
    feedbackDestination,
    feedbackPageUrl,
    THALASSA_FEEDBACK_URL,
} from '../services/externalLinks';

describe('feedback app link', () => {
    beforeEach(() => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.mocked(App.getInfo).mockClear();
    });

    it('appends bounded web version, build, platform and source context', async () => {
        const url = new URL(await feedbackPageUrl());

        expect(url.origin + url.pathname).toBe(THALASSA_FEEDBACK_URL);
        expect(url.searchParams.get('source')).toBe('app_settings');
        expect(url.searchParams.get('appVersion')).toBeTruthy();
        expect(url.searchParams.get('build')).toBeTruthy();
        expect(url.searchParams.get('platform')).toBe('web');
        expect(url.searchParams.get('appVersion')?.length).toBeLessThanOrEqual(40);
        expect(url.searchParams.get('build')?.length).toBeLessThanOrEqual(40);
        expect(App.getInfo).not.toHaveBeenCalled();
    });

    it('uses the exact native app version and build on iOS', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(App.getInfo).mockResolvedValue({
            name: 'Thalassa',
            id: 'com.thalassa.weather',
            version: '1.2.0',
            build: '101',
        });

        const url = new URL(await feedbackDestination());

        expect(url.searchParams.get('appVersion')).toBe('1.2.0');
        expect(url.searchParams.get('build')).toBe('101');
        expect(url.searchParams.get('platform')).toBe('ios');
    });

    it('keeps the offline fallback useful without opening a dead web page', () => {
        const mailto = betaFeedbackUrl({ appVersion: '1.2.0', build: '101', platform: 'ios' });
        const decoded = decodeURIComponent(mailto);

        expect(decoded).toMatch(/^mailto:privacy@thalassawx\.com\?/u);
        expect(decoded).toContain('App version: 1.2.0');
        expect(decoded).toContain('Build: 101');
        expect(decoded).toContain('Platform: ios');
    });
});
