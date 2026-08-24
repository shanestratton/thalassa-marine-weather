export const BOAT_TYPES = [
    { value: 'sail_monohull', label: 'Sailing monohull' },
    { value: 'sail_multihull', label: 'Sailing multihull' },
    { value: 'power', label: 'Power boat' },
    { value: 'trailer_boat', label: 'Trailer boat' },
    { value: 'other', label: 'Something else' },
] as const;

export const APPLE_DEVICES = [
    { value: 'iphone', label: 'iPhone' },
    { value: 'ipad', label: 'iPad' },
    { value: 'iphone_and_ipad', label: 'iPhone and iPad' },
] as const;

export const BOATING_FREQUENCIES = [
    { value: 'weekly_plus', label: 'Weekly or more' },
    { value: 'fortnightly', label: 'Every couple of weeks' },
    { value: 'monthly', label: 'About monthly' },
    { value: 'less_often', label: 'Less often / seasonal' },
] as const;

export const TESTING_INTERESTS = [
    { value: 'marine_weather', label: 'Marine weather' },
    { value: 'passage_planning', label: 'Passage planning' },
    { value: 'float_plans', label: 'Float plans' },
    { value: 'anchor_watch', label: 'Anchor Watch' },
    { value: 'voyage_logging', label: 'Voyage logging' },
    { value: 'onboard_data', label: 'Onboard data' },
] as const;

export interface FoundingSkipperApplication {
    name: string;
    email: string;
    boatType: (typeof BOAT_TYPES)[number]['value'];
    homeWaters: string;
    appleDevice: (typeof APPLE_DEVICES)[number]['value'];
    boatingFrequency: (typeof BOATING_FREQUENCIES)[number]['value'];
    interests: Array<(typeof TESTING_INTERESTS)[number]['value']>;
    notes?: string;
    consent: true;
    source: string;
    website?: string;
}

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');

export async function submitFoundingSkipperApplication(
    application: FoundingSkipperApplication,
): Promise<void> {
    if (!SUPABASE_URL) throw new Error('Applications are not connected yet.');

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/founding-skipper-application`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(application),
            signal: controller.signal,
        });
        if (!response.ok) {
            let message = 'We could not send that application. Please try again.';
            try {
                const body = (await response.json()) as { error?: unknown };
                if (typeof body.error === 'string' && body.error.length <= 180) message = body.error;
            } catch {
                // A fixed local fallback keeps upstream diagnostics out of the page.
            }
            throw new Error(message);
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error('The connection timed out. Please check your signal and try again.');
        }
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}
