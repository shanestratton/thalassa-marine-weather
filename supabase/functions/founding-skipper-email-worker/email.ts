import { readResponseJsonObjectLimited } from '../_shared/http-security.ts';

const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_USER_AGENT = 'thalassa-founding-skippers/2.0';
const EMAIL_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PROVIDER_MESSAGE_ID = /^[a-z0-9_-]{1,200}$/iu;

export const FOUNDING_SKIPPER_MESSAGE_KINDS = [
    'operator_new_v1',
    'applicant_received_v1',
    'applicant_accepted_v1',
] as const;

export type FoundingSkipperMessageKind = (typeof FOUNDING_SKIPPER_MESSAGE_KINDS)[number];

export interface FoundingSkipperEmailJob {
    jobId: string;
    leaseToken: string;
    applicationId: string;
    messageKind: FoundingSkipperMessageKind;
    attempts: number;
    name: string;
    email: string;
    boatType: string;
    homeWaters: string;
    appleDevice: string;
    boatingFrequency: string;
    interests: string[];
    notes: string | null;
    source: string;
    consentVersion: 'founding-skippers-v1' | 'founding-skippers-v2';
    applicationStatus: string;
}

export interface FoundingSkipperEmailConfig {
    apiKey: string;
    alertTo: string;
    alertFrom: string;
    applicantFrom: string;
    replyTo: string;
}

export interface RenderedFoundingSkipperEmail {
    from: string;
    to: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
}

export type FoundingSkipperDeliveryResult =
    | { outcome: 'sent'; providerMessageId: string }
    | { outcome: 'retry'; errorCode: string; retryAfterSeconds: number; terminal: boolean }
    | { outcome: 'dead'; errorCode: string };

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

export function isSafeEmailAddress(value: string): boolean {
    return value.length <= 254 && !hasHeaderControl(value) && EMAIL.test(value);
}

function isSafeMailbox(value: string): boolean {
    if (value.length > 320 || hasHeaderControl(value)) return false;
    if (isSafeEmailAddress(value)) return true;

    const match = value.match(/^([^<>]{1,100})\s*<([^<>]+)>$/u);
    return Boolean(match && match[1].trim() && isSafeEmailAddress(match[2].trim()));
}

/** Read the complete server-side configuration. Partial configuration fails closed. */
export function readFoundingSkipperEmailConfig(
    readEnvironment: ReadEnvironment = (name) => Deno.env.get(name),
): FoundingSkipperEmailConfig | null {
    const apiKey = safeHeader(readEnvironment('RESEND_API_KEY'), 512);
    const alertTo = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_TO'), 254);
    const alertFrom = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_FROM'), 320);
    const applicantFrom = safeHeader(readEnvironment('FOUNDING_SKIPPER_APPLICANT_FROM'), 320);
    const replyTo = safeHeader(readEnvironment('FOUNDING_SKIPPER_REPLY_TO'), 254);

    if (
        !apiKey ||
        !alertTo ||
        !alertFrom ||
        !applicantFrom ||
        !replyTo ||
        !isSafeEmailAddress(alertTo) ||
        !isSafeMailbox(alertFrom) ||
        !isSafeMailbox(applicantFrom) ||
        !isSafeEmailAddress(replyTo)
    ) {
        return null;
    }

    return { apiKey, alertTo, alertFrom, applicantFrom, replyTo };
}

export function escapeEmailHtml(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

export function escapeEmailText(value: string): string {
    let escaped = '';
    for (const character of value.replace(/\r\n?/gu, '\n')) {
        const code = character.codePointAt(0) ?? 0;
        escaped += code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
            ? '�'
            : character;
    }
    return escaped;
}

function htmlValue(value: string): string {
    return escapeEmailHtml(escapeEmailText(value)).replace(/\n/gu, '<br>');
}

function textValue(value: string): string {
    return escapeEmailText(value).replace(/\n/gu, '\n  ');
}

function label(value: string, labels: Record<string, string>): string {
    return labels[value] ?? value;
}

function applicantFirstName(name: string): string {
    return name.trim().split(/\s+/u)[0]?.slice(0, 40) || 'Skipper';
}

function brandedHtml(title: string, content: string, eyebrow = 'THALASSA · FOUNDING SKIPPERS'): string {
    return [
        '<!doctype html>',
        '<html lang="en"><body style="margin:0;padding:0;background:#eef7f8;">',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef7f8;">',
        '<tr><td align="center" style="padding:28px 14px;">',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid #dbe7ea;border-radius:16px;overflow:hidden;">',
        '<tr><td style="height:7px;background:#0f766e;font-size:0;line-height:0;">&nbsp;</td></tr>',
        '<tr><td style="padding:30px 30px 12px;">',
        `<p style="margin:0 0 13px;color:#0f766e;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.2px;">${eyebrow}</p>`,
        `<h1 style="margin:0;color:#102a43;font-family:Arial,sans-serif;font-size:27px;line-height:1.22;">${title}</h1>`,
        '</td></tr>',
        `<tr><td style="padding:8px 30px 30px;color:#243b53;font-family:Arial,sans-serif;font-size:16px;line-height:1.62;">${content}</td></tr>`,
        '<tr><td style="padding:18px 30px;background:#f7fafc;border-top:1px solid #e5edf0;color:#627d98;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;">',
        'Thalassa Marine Weather · Built with Australian skippers, for real days on the water.',
        '</td></tr></table>',
        '</td></tr></table></body></html>',
    ].join('');
}

function operatorRow(name: string, value: string): string {
    return [
        '<tr>',
        `<th align="left" valign="top" style="padding:7px 14px 7px 0;color:#627d98;font-family:Arial,sans-serif;font-size:13px;white-space:nowrap;">${name}</th>`,
        `<td valign="top" style="padding:7px 0;color:#102a43;font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">${
            htmlValue(value)
        }</td>`,
        '</tr>',
    ].join('');
}

function renderOperatorEmail(
    job: FoundingSkipperEmailJob,
    config: FoundingSkipperEmailConfig,
): RenderedFoundingSkipperEmail {
    const values = [
        ['Name', job.name],
        ['Email', job.email],
        ['Boat', label(job.boatType, BOAT_TYPE_LABELS)],
        ['Home waters', job.homeWaters],
        ['Apple device', label(job.appleDevice, APPLE_DEVICE_LABELS)],
        ['Boating frequency', label(job.boatingFrequency, FREQUENCY_LABELS)],
        ['Testing interests', job.interests.map((interest) => label(interest, INTEREST_LABELS)).join(', ')],
        ['Source', job.source],
        ['Notes', job.notes || 'None supplied'],
        ['Application ID', job.applicationId],
    ] as const;

    const text = [
        'New Thalassa Founding Skipper application',
        '',
        ...values.map(([name, value]) => `${name}: ${textValue(value)}`),
        '',
        "Review this application in Thalassa's private Admin Panel.",
    ].join('\n');
    const content = [
        '<p style="margin:0 0 18px;">A new skipper has applied to help test Thalassa.</p>',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">',
        ...values.map(([name, value]) => operatorRow(name, value)),
        '</table>',
        '<p style="margin:22px 0 0;color:#627d98;font-size:13px;">Review this application in Thalassa&#39;s private Admin Panel.</p>',
    ].join('');

    return {
        from: config.alertFrom,
        to: config.alertTo,
        replyTo: job.email,
        subject: 'New Thalassa Founding Skipper application',
        html: brandedHtml('A new skipper has applied', content),
        text,
    };
}

function renderReceivedEmail(
    job: FoundingSkipperEmailJob,
    config: FoundingSkipperEmailConfig,
): RenderedFoundingSkipperEmail {
    const firstName = applicantFirstName(job.name);
    const safeFirstName = htmlValue(firstName);
    const title = "We've received your application";
    const content = [
        `<p style="margin:0 0 16px;">G&#39;day ${safeFirstName},</p>`,
        '<p style="margin:0 0 16px;">Thanks for putting your hand up to become a Thalassa Founding Skipper. Your application is safely aboard and we&#39;ll review it personally.</p>',
        '<div style="margin:20px 0;padding:16px 18px;border-left:4px solid #14b8a6;background:#f0fdfa;border-radius:8px;">This confirms we received your application; it is not an acceptance just yet.</div>',
        '<p style="margin:0 0 16px;">If the program looks like a good fit, we&#39;ll email you with the next steps and beta access details.</p>',
        '<p style="margin:22px 0 0;">Fair winds,<br><strong>The Thalassa crew</strong></p>',
    ].join('');
    const text = [
        `G'day ${escapeEmailText(firstName)},`,
        '',
        "Thanks for putting your hand up to become a Thalassa Founding Skipper. Your application is safely aboard and we'll review it personally.",
        '',
        'This confirms we received your application; it is not an acceptance just yet.',
        '',
        "If the program looks like a good fit, we'll email you with the next steps and beta access details.",
        '',
        'Fair winds,',
        'The Thalassa crew',
    ].join('\n');

    return {
        from: config.applicantFrom,
        to: job.email,
        replyTo: config.replyTo,
        subject: "We've received your Thalassa beta application",
        html: brandedHtml(title, content),
        text,
    };
}

function renderAcceptedEmail(
    job: FoundingSkipperEmailJob,
    config: FoundingSkipperEmailConfig,
): RenderedFoundingSkipperEmail {
    const firstName = applicantFirstName(job.name);
    const safeFirstName = htmlValue(firstName);
    const title = 'Welcome aboard, Founding Skipper';
    const content = [
        `<p style="margin:0 0 16px;">G&#39;day ${safeFirstName},</p>`,
        '<p style="margin:0 0 16px;">You&#39;re in. Welcome to the Thalassa beta program and our first crew of Founding Skippers.</p>',
        '<p style="margin:22px 0 10px;color:#102a43;font-size:18px;font-weight:700;">What we ask of you</p>',
        '<ul style="margin:0 0 18px;padding-left:22px;">',
        '<li style="margin:0 0 9px;">Use the core features during your normal boating routine and tell us what is genuinely useful.</li>',
        '<li style="margin:0 0 9px;">Send candid feedback. For bugs, a screenshot plus what you were doing helps us enormously.</li>',
        '<li style="margin:0 0 9px;">Report anything that could affect safety promptly by replying to this email.</li>',
        '<li style="margin:0;">Expect rough edges and regular changes while the beta is under way.</li>',
        '</ul>',
        '<div style="margin:20px 0;padding:16px 18px;border-left:4px solid #f59e0b;background:#fffbeb;border-radius:8px;"><strong>Keep normal seamanship in charge.</strong><br>Thalassa is a planning aid. During the beta it does not replace official marine forecasts, current approved charts, notices, emergency services, or your own judgement.</div>',
        '<p style="margin:0 0 16px;">We&#39;ll send your beta access instructions separately. When they arrive, give the app a proper run and reply whenever something delights, confuses, or frustrates you.</p>',
        '<p style="margin:22px 0 0;">Thanks for helping us build this properly.<br><strong>The Thalassa crew</strong></p>',
    ].join('');
    const text = [
        `G'day ${escapeEmailText(firstName)},`,
        '',
        "You're in. Welcome to the Thalassa beta program and our first crew of Founding Skippers.",
        '',
        'WHAT WE ASK OF YOU',
        '- Use the core features during your normal boating routine and tell us what is genuinely useful.',
        '- Send candid feedback. For bugs, a screenshot plus what you were doing helps us enormously.',
        '- Report anything that could affect safety promptly by replying to this email.',
        '- Expect rough edges and regular changes while the beta is under way.',
        '',
        'KEEP NORMAL SEAMANSHIP IN CHARGE',
        'Thalassa is a planning aid. During the beta it does not replace official marine forecasts, current approved charts, notices, emergency services, or your own judgement.',
        '',
        "We'll send your beta access instructions separately. When they arrive, give the app a proper run and reply whenever something delights, confuses, or frustrates you.",
        '',
        'Thanks for helping us build this properly.',
        'The Thalassa crew',
    ].join('\n');

    return {
        from: config.applicantFrom,
        to: job.email,
        replyTo: config.replyTo,
        subject: "Welcome aboard Thalassa's Founding Skippers",
        html: brandedHtml(title, content),
        text,
    };
}

export function renderFoundingSkipperEmail(
    job: FoundingSkipperEmailJob,
    config: FoundingSkipperEmailConfig,
): RenderedFoundingSkipperEmail {
    switch (job.messageKind) {
        case 'operator_new_v1':
            return renderOperatorEmail(job, config);
        case 'applicant_received_v1':
            return renderReceivedEmail(job, config);
        case 'applicant_accepted_v1':
            return renderAcceptedEmail(job, config);
    }
}

function boundedRetryAfter(value: string | null, now = Date.now()): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds >= 0) return Math.min(Math.max(seconds, 15), 86_400);

    const date = Date.parse(value);
    if (!Number.isFinite(date)) return null;
    return Math.min(Math.max(Math.ceil((date - now) / 1_000), 15), 86_400);
}

function retryDelay(attempts: number): number {
    return Math.min(30 * 2 ** Math.max(0, Math.min(attempts - 1, 7)), 3_600);
}

export function classifyResendFailure(
    status: number,
    attempts: number,
    retryAfterHeader: string | null = null,
): FoundingSkipperDeliveryResult {
    if (status >= 400 && status < 500 && status !== 429) {
        return { outcome: 'dead', errorCode: `resend_http_${status}` };
    }

    const retryAfterSeconds = boundedRetryAfter(retryAfterHeader) ?? retryDelay(attempts);
    return {
        outcome: 'retry',
        errorCode: status === 429 ? 'resend_rate_limited' : status >= 500 ? 'resend_unavailable' : 'resend_unexpected',
        retryAfterSeconds,
        terminal: attempts >= MAX_DELIVERY_ATTEMPTS,
    };
}

export async function deliverFoundingSkipperEmail(
    job: FoundingSkipperEmailJob,
    config: FoundingSkipperEmailConfig | null,
    fetcher: FetchLike = fetch,
): Promise<FoundingSkipperDeliveryResult> {
    if (!config) {
        return {
            outcome: 'retry',
            errorCode: 'email_not_configured',
            retryAfterSeconds: 300,
            terminal: false,
        };
    }

    const rendered = renderFoundingSkipperEmail(job, config);
    if (
        !isSafeMailbox(rendered.from) ||
        !isSafeEmailAddress(rendered.to) ||
        !isSafeEmailAddress(rendered.replyTo)
    ) {
        return { outcome: 'dead', errorCode: 'invalid_email_headers' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
        const response = await fetcher(RESEND_EMAILS_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `founding-skipper/${job.applicationId}/${job.messageKind}/v1`,
                'User-Agent': EMAIL_USER_AGENT,
            },
            body: JSON.stringify({
                from: rendered.from,
                to: [rendered.to],
                reply_to: rendered.replyTo,
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const result = classifyResendFailure(response.status, job.attempts, response.headers.get('retry-after'));
            await response.body?.cancel().catch(() => undefined);
            return result;
        }

        const body = await readResponseJsonObjectLimited(response, 32_768);
        const providerMessageId = typeof body?.id === 'string' && PROVIDER_MESSAGE_ID.test(body.id) ? body.id : null;
        if (!providerMessageId) {
            return {
                outcome: 'retry',
                errorCode: 'resend_invalid_response',
                retryAfterSeconds: retryDelay(job.attempts),
                terminal: job.attempts >= MAX_DELIVERY_ATTEMPTS,
            };
        }

        return { outcome: 'sent', providerMessageId };
    } catch {
        return {
            outcome: 'retry',
            errorCode: 'resend_network_error',
            retryAfterSeconds: retryDelay(job.attempts),
            terminal: job.attempts >= MAX_DELIVERY_ATTEMPTS,
        };
    } finally {
        clearTimeout(timeout);
    }
}
