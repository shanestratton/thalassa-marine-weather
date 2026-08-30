import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export const THALASSA_TERMS_URL = 'https://www.thalassawx.app/terms.html';
export const THALASSA_SUPPORT_EMAIL = 'privacy@thalassawx.com';
/*
 * The canonical address Shane gave on 2026-08-28, pointed at directly.
 *
 * This was thalassawx.com/feedback, which 308s to the same place with the
 * query string intact — so it worked, and it cost a redirect on every tap and
 * left the button depending on a second domain staying registered and
 * pointed. The terms link already uses www.thalassawx.app; this now matches.
 */
export const THALASSA_FEEDBACK_URL = 'https://www.thalassawx.app/feedback';

/**
 * The o-charts page that takes a fingerprint and issues an InstallPermit.
 *
 * Linked directly rather than sending people to the shop's front door: "now go
 * and find the website" is a step that loses people, and this page is several
 * clicks in behind a login.
 */
export const OCHARTS_USERPERMITS_URL = 'https://o-charts.org/shop/en/module/ocpermits/ocpermits';

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

interface FeedbackLaunchContext {
    appVersion: string;
    build: string;
    platform: string;
}

function boundedFeedbackContext(value: string | undefined, fallback: string): string {
    const normalized = (value || fallback).normalize('NFKC').trim();
    if (!normalized || [...normalized].some((character) => (character.codePointAt(0) ?? 0) <= 31)) {
        return fallback;
    }
    return normalized.slice(0, 40);
}

function bundledFeedbackContext(): FeedbackLaunchContext {
    const bundleStamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'unknown';
    return {
        appVersion: boundedFeedbackContext(import.meta.env.VITE_APP_VERSION, 'unknown'),
        build: boundedFeedbackContext(bundleStamp, 'unknown'),
        platform: boundedFeedbackContext(Capacitor.getPlatform(), 'unknown'),
    };
}

async function feedbackLaunchContext(): Promise<FeedbackLaunchContext> {
    const fallback = bundledFeedbackContext();
    if (!Capacitor.isNativePlatform()) return fallback;

    try {
        const info = await App.getInfo();
        return {
            appVersion: boundedFeedbackContext(info.version, fallback.appVersion),
            build: boundedFeedbackContext(info.build, fallback.build),
            platform: fallback.platform,
        };
    } catch {
        // The feedback route must still open if native app metadata is briefly
        // unavailable. The bundled release values are useful fallback context.
        return fallback;
    }
}

function feedbackUrl(context: FeedbackLaunchContext): string {
    const url = new URL(THALASSA_FEEDBACK_URL);
    url.searchParams.set('source', 'app_settings');
    url.searchParams.set('appVersion', context.appVersion);
    url.searchParams.set('build', context.build);
    url.searchParams.set('platform', context.platform);
    return url.toString();
}

/**
 * The mailto route. No longer the front door — see feedbackDestination — but
 * kept because it is the only one that survives with no connectivity, which
 * is a state this app's users are in fairly often and by choice.
 */
export function betaFeedbackUrl(context: FeedbackLaunchContext = bundledFeedbackContext()): string {
    const subject = 'Thalassa Public Beta Feedback';
    const body = `\n\nWhat happened?\n\nWhat did you expect?\n\nApp version: ${context.appVersion}\nBuild: ${context.build}\nPlatform: ${context.platform}`;
    return `mailto:${THALASSA_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The bug-and-feature page, when there is one and the phone can reach it.
 *
 * The native App plugin supplies the App Store version and build. Web builds
 * use the public release version and bundle stamp. The feedback form treats
 * these values as report context, not as trusted identity claims.
 */
export async function feedbackPageUrl(): Promise<string> {
    return feedbackUrl(await feedbackLaunchContext());
}

/**
 * Where the Beta Support button actually goes.
 *
 * The page when it is reachable; the mailto otherwise. Offline
 * is checked because navigator.onLine is trustworthy in exactly one
 * direction — if it says offline, it is — and a feedback button that opens a
 * page that cannot load is worse than one that opens a mail draft which will
 * send itself later.
 */
export async function feedbackDestination(): Promise<string> {
    const context = await feedbackLaunchContext();
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) return betaFeedbackUrl(context);
    return feedbackUrl(context);
}

/**
 * "1.4.2 (312) · ios" — the build actually running, for the info panel.
 *
 * Lives here because feedbackLaunchContext already resolves it from
 * App.getInfo() with a bundle-stamp fallback, and a second copy of that logic
 * would be a second thing to drift. Shane 2026-08-28: "we should show the
 * version of thalassa on one line. so we always no what version we are on."
 *
 * He is not being fussy. Half of today went on "the wind goes stale", where
 * the answer depended on whether the phone was running this morning's build
 * or this afternoon's, and nothing on the screen could say.
 */
export async function appBuildLabel(): Promise<string> {
    const context = await feedbackLaunchContext();
    return `${context.appVersion} (${context.build}) · ${context.platform}`;
}

export async function openFeedbackDestination(): Promise<void> {
    await openExternalUrl(await feedbackDestination());
}
