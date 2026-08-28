import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    betaFeedbackUrl,
    feedbackDestination,
    feedbackPageUrl,
    THALASSA_FEEDBACK_URL,
    THALASSA_TERMS_URL,
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

/**
 * Shane gave the address himself on 2026-08-28:
 * "https://www.thalassawx.app/feedback - this is the new webpage for gripes
 * and ideas claude, you know where it goes."
 *
 * It had been pointed at thalassawx.com/feedback, which 308s to exactly this
 * with the query string intact. That worked — and it spent a redirect on
 * every tap and left the button depending on a second domain staying
 * registered and pointed at the first. The terms link has always used
 * www.thalassawx.app.
 */
describe('the feedback address', () => {
    it('is the canonical one, not the redirecting one', () => {
        expect(THALASSA_FEEDBACK_URL).toBe('https://www.thalassawx.app/feedback');
    });

    it('shares a host with the terms link, so one domain carries both', () => {
        expect(new URL(THALASSA_FEEDBACK_URL).host).toBe(new URL(THALASSA_TERMS_URL).host);
    });

    it('is https, since the punter is typing a bug report into it', () => {
        expect(new URL(THALASSA_FEEDBACK_URL).protocol).toBe('https:');
    });
});
