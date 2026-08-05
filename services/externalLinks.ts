import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

export const THALASSA_TERMS_URL = 'https://www.thalassawx.app/terms.html';
export const THALASSA_SUPPORT_EMAIL = 'privacy@thalassa.app';

export async function openExternalUrl(url: string): Promise<void> {
    if (/^mailto:/i.test(url)) {
        if (typeof window !== 'undefined') window.location.href = url;
        return;
    }

    if (Capacitor.isNativePlatform()) {
        try {
            await Browser.open({ url, presentationStyle: 'popover' });
            return;
        } catch {
            // Fall back to the system/WebView link handler below.
        }
    }
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

export function betaFeedbackUrl(): string {
    const version = import.meta.env.VITE_APP_VERSION || 'unknown';
    const platform = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;
    const subject = 'Thalassa Public Beta Feedback';
    const body = `\n\nWhat happened?\n\nWhat did you expect?\n\nApp version: ${version}\nPlatform: ${platform}`;
    return `mailto:${THALASSA_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
