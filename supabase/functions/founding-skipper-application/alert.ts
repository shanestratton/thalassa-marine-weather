const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const ALERT_SUBJECT = 'New Founding Skipper application';
const ALERT_USER_AGENT = 'thalassa-founding-skippers/1.0';
const ALERT_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface FoundingSkipperAlertApplication {
    id: string;
    name: string;
    email: string;
    boatType: string;
    homeWaters: string;
    appleDevice: string;
    boatingFrequency: string;
    interests: string[];
    notes: string | null;
    source: string;
}

export interface FoundingSkipperAlertConfig {
    apiKey: string;
    from: string;
    to: string;
}

export type FoundingSkipperAlertResult =
    | { status: 'sent' }
    | { status: 'skipped'; reason: 'not_configured' | 'invalid_application_id' }
    | { status: 'failed'; reason: 'provider_rejected' | 'network_error'; providerStatus?: number };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ReadEnvironment = (name: string) => string | undefined;

const BOAT_TYPE_LABELS: Record<string, string> = {
    sail_monohull: 'Sailing monohull',
    sail_multihull: 'Sailing multihull',
    power: 'Power boat',
    trailer_boat: 'Trailer boat',
    other: 'Something else',
};

const APPLE_DEVICE_LABELS: Record<string, string> = {
    iphone: 'iPhone',
    ipad: 'iPad',
    iphone_and_ipad: 'iPhone and iPad',
};

const FREQUENCY_LABELS: Record<string, string> = {
    weekly_plus: 'Weekly or more',
    fortnightly: 'Every couple of weeks',
    monthly: 'About monthly',
    less_often: 'Less often / seasonal',
};

const INTEREST_LABELS: Record<string, string> = {
    marine_weather: 'Marine weather',
    passage_planning: 'Passage planning',
    float_plans: 'Float plans',
    anchor_watch: 'Anchor Watch',
    voyage_logging: 'Voyage logging',
    onboard_data: 'Onboard data',
};

function hasHeaderControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

function safeHeader(value: string | undefined, maxLength: number): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed && trimmed.length <= maxLength && !hasHeaderControl(trimmed) ? trimmed : null;
}

/** Read only server-side Edge Function secrets. Missing/invalid values disable alerts without affecting submissions. */
export function readFoundingSkipperAlertConfig(
    readEnvironment: ReadEnvironment = (name) => Deno.env.get(name),
): FoundingSkipperAlertConfig | null {
    const apiKey = safeHeader(readEnvironment('RESEND_API_KEY'), 512);
    const from = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_FROM'), 320);
    const to = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_TO'), 254);

    if (!apiKey || !from || !to || !EMAIL.test(to)) return null;
    return { apiKey, from, to };
}

/** Escape untrusted values before placing them in the HTML part of the alert. */
export function escapeAlertHtml(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

/** Normalise untrusted values for the text part without allowing hidden control characters. */
export function escapeAlertText(value: string): string {
    let escaped = '';
    for (const character of value.replace(/\r\n?/gu, '\n')) {
        const code = character.codePointAt(0) ?? 0;
        escaped += code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
            ? '�'
            : character;
    }
    return escaped;
}

function label(value: string, labels: Record<string, string>): string {
    return labels[value] ?? value;
}

function indentText(value: string): string {
    return escapeAlertText(value).replace(/\n/gu, '\n  ');
}

function htmlValue(value: string): string {
    return escapeAlertHtml(escapeAlertText(value)).replace(/\n/gu, '<br>');
}

function htmlRow(name: string, value: string): string {
    return [
        '<tr>',
        `<th align="left" valign="top" style="padding:6px 12px 6px 0;color:#64748b;font-family:Arial,sans-serif;font-size:13px;white-space:nowrap;">${name}</th>`,
        `<td valign="top" style="padding:6px 0;color:#0f172a;font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">${
            htmlValue(value)
        }</td>`,
        '</tr>',
    ].join('');
}

export function renderFoundingSkipperAlert(application: FoundingSkipperAlertApplication): {
    subject: string;
    html: string;
    text: string;
} {
    const interests = application.interests.map((interest) => label(interest, INTEREST_LABELS)).join(', ');
    const notes = application.notes || 'None supplied';
    const values = [
        ['Name', application.name],
        ['Email', application.email],
        ['Boat', label(application.boatType, BOAT_TYPE_LABELS)],
        ['Home waters', application.homeWaters],
        ['Apple device', label(application.appleDevice, APPLE_DEVICE_LABELS)],
        ['Boating frequency', label(application.boatingFrequency, FREQUENCY_LABELS)],
        ['Testing interests', interests],
        ['Source', application.source],
        ['Notes', notes],
        ['Application ID', application.id],
    ] as const;

    const text = [
        ALERT_SUBJECT,
        '',
        ...values.map(([name, value]) => `${name}: ${indentText(value)}`),
        '',
        "Review and update the application in Thalassa's private Admin Panel.",
    ].join('\n');

    const html = [
        '<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;">',
        '<div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">',
        '<p style="margin:0 0 18px;color:#0f766e;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1px;">THALASSA · FOUNDING SKIPPERS</p>',
        `<h1 style="margin:0 0 18px;color:#0f172a;font-family:Arial,sans-serif;font-size:24px;line-height:1.25;">${ALERT_SUBJECT}</h1>`,
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">',
        ...values.map(([name, value]) => htmlRow(name, value)),
        '</table>',
        '<p style="margin:22px 0 0;color:#64748b;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;">Review and update the application in Thalassa&#39;s private Admin Panel.</p>',
        '</div></body></html>',
    ].join('');

    return { subject: ALERT_SUBJECT, html, text };
}

export async function sendFoundingSkipperAlert(
    application: FoundingSkipperAlertApplication,
    config: FoundingSkipperAlertConfig | null,
    fetcher: FetchLike = fetch,
): Promise<FoundingSkipperAlertResult> {
    if (!config) return { status: 'skipped', reason: 'not_configured' };
    if (!UUID.test(application.id)) return { status: 'skipped', reason: 'invalid_application_id' };

    const rendered = renderFoundingSkipperAlert(application);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
        const response = await fetcher(RESEND_EMAILS_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `founding-skipper-application/${application.id}`,
                'User-Agent': ALERT_USER_AGENT,
            },
            body: JSON.stringify({
                from: config.from,
                to: [config.to],
                reply_to: EMAIL.test(application.email) && !hasHeaderControl(application.email)
                    ? application.email
                    : undefined,
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            return { status: 'failed', reason: 'provider_rejected', providerStatus: response.status };
        }
        return { status: 'sent' };
    } catch {
        return { status: 'failed', reason: 'network_error' };
    } finally {
        clearTimeout(timeout);
    }
}
