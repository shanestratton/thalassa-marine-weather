export const FEEDBACK_AREAS = [
    { value: 'weather', label: 'Weather' },
    { value: 'charts_obs', label: 'Charts & OBS' },
    { value: 'passage_planning', label: 'Passage planning' },
    { value: 'anchor_watch', label: 'Anchor Watch' },
    { value: 'voyage_log', label: 'Voyage Log' },
    { value: 'crew_list', label: 'Crew List' },
    { value: 'vessel_nmea', label: 'Vessel & NMEA' },
    { value: 'account', label: 'Account & sign-in' },
    { value: 'website', label: 'Website' },
    { value: 'other', label: 'Something else' },
] as const;

export const BUG_IMPACTS = [
    { value: 'blocking', label: 'Stops me using it' },
    { value: 'serious', label: 'Serious problem' },
    { value: 'annoying', label: 'Annoying' },
    { value: 'cosmetic', label: 'Looks wrong' },
] as const;

export const FEATURE_IMPACTS = [
    { value: 'game_changer', label: 'Game changer' },
    { value: 'important', label: 'Important' },
    { value: 'nice_to_have', label: 'Nice to have' },
] as const;

export const PRODUCT_FEEDBACK_CONSENT_VERSION = 'product-feedback-v1' as const;

export type FeedbackKind = 'bug' | 'feature';
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number]['value'];
export type BugImpact = (typeof BUG_IMPACTS)[number]['value'];
export type FeatureImpact = (typeof FEATURE_IMPACTS)[number]['value'];
export type FeedbackImpact = BugImpact | FeatureImpact;

export interface FeedbackDiagnostics {
    platform: string;
    userAgent: string;
    screen: string;
    viewport: string;
    language: string;
    online: boolean;
    currentPath: string;
}

export interface FeedbackAppContext {
    appVersion: string;
    appBuild: string;
    appPlatform: string;
}

export interface FeedbackSubmission {
    clientSubmissionId: string;
    kind: FeedbackKind;
    name: string;
    email: string;
    area: FeedbackArea;
    title: string;
    details: string;
    impact: FeedbackImpact;
    stepsToReproduce: string;
    expectedResult: string;
    actualResult: string;
    problemToSolve: string;
    idealOutcome: string;
    device: string;
    appVersion: string;
    appBuild: string;
    appPlatform: string;
    diagnostics: FeedbackDiagnostics | null;
    source: string;
    consent: true;
    consentVersion: typeof PRODUCT_FEEDBACK_CONSENT_VERSION;
    website: string;
}

export interface FeedbackSubmissionReceipt {
    reference: string;
}

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/u;
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/u, '');

function bounded(value: string | undefined, max: number): string {
    return (value ?? '').normalize('NFKC').trim().slice(0, max);
}

function safeAppContextValue(value: string | null): string {
    if (value === null) return '';
    const normalized = value.normalize('NFKC').trim();
    if (normalized.length === 0 || normalized.length > 40) return '';
    const hasControl = [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
    return hasControl ? '' : normalized;
}

export function sourceFromLocation(location: Pick<Location, 'search'> = window.location): string {
    const candidate = new URLSearchParams(location.search).get('source')?.trim().toLowerCase() ?? '';
    return SOURCE_PATTERN.test(candidate) ? candidate : 'direct';
}

export function kindFromLocation(location: Pick<Location, 'search'> = window.location): FeedbackKind {
    return new URLSearchParams(location.search).get('type')?.trim().toLowerCase() === 'feature' ? 'feature' : 'bug';
}

export function appContextFromLocation(location: Pick<Location, 'search'> = window.location): FeedbackAppContext {
    const params = new URLSearchParams(location.search);
    return {
        appVersion: safeAppContextValue(params.get('appVersion')),
        appBuild: safeAppContextValue(params.get('build')),
        appPlatform: safeAppContextValue(params.get('platform')),
    };
}

export function createClientSubmissionId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function captureFeedbackDiagnostics(): FeedbackDiagnostics {
    const screenWidth = typeof screen === 'undefined' ? 0 : screen.width;
    const screenHeight = typeof screen === 'undefined' ? 0 : screen.height;
    return {
        platform: bounded(navigator.platform, 120),
        userAgent: bounded(navigator.userAgent, 512),
        screen: `${screenWidth}x${screenHeight}`.slice(0, 40),
        viewport: `${window.innerWidth}x${window.innerHeight}`.slice(0, 40),
        language: bounded(navigator.language, 32),
        online: navigator.onLine,
        // Path only: deliberately exclude query parameters and fragments, which
        // can contain campaign tags or other caller-provided information.
        currentPath: bounded(window.location.pathname, 120),
    };
}

export async function submitProductFeedback(submission: FeedbackSubmission): Promise<FeedbackSubmissionReceipt> {
    if (!SUPABASE_URL) throw new Error('Feedback is not connected yet. Please try again shortly.');

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/feedback-submission`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission),
            signal: controller.signal,
        });

        if (!response.ok) {
            let message = 'We could not send that feedback. Please try again.';
            try {
                const body = (await response.json()) as { error?: unknown };
                if (typeof body.error === 'string' && body.error.length <= 180) message = body.error;
            } catch {
                // Keep provider diagnostics and response bodies off the page.
            }
            throw new Error(message);
        }

        const body = (await response.json()) as { ok?: unknown; reference?: unknown };
        if (body.ok !== true || typeof body.reference !== 'string' || !REFERENCE_PATTERN.test(body.reference)) {
            throw new Error('Your feedback may have arrived, but we could not read the receipt. Please try again.');
        }
        return { reference: body.reference };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error('The connection timed out. Please check your signal and try again.');
        }
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}
