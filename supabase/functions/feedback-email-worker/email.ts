import { readResponseJsonObjectLimited } from '../_shared/http-security.ts';

const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_USER_AGENT = 'thalassa-product-feedback/1.0';
const EMAIL_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PROVIDER_MESSAGE_ID = /^[a-z0-9_-]{1,200}$/iu;

export const FEEDBACK_MESSAGE_KINDS = ['operator_new_v1', 'submitter_received_v1'] as const;
export type FeedbackMessageKind = (typeof FEEDBACK_MESSAGE_KINDS)[number];

export interface FeedbackEmailDiagnostics {
    platform: string;
    userAgent: string;
    screen: string;
    viewport: string;
    language: string;
    online: boolean;
    currentPath: string;
}

export interface FeedbackEmailJob {
    jobId: string;
    leaseToken: string;
    submissionId: string;
    messageKind: FeedbackMessageKind;
    attempts: number;
    reference: string;
    kind: 'bug' | 'feature';
    name: string;
    email: string;
    area: string;
    title: string;
    details: string;
    impact: string;
    stepsToReproduce: string | null;
    expectedResult: string | null;
    actualResult: string | null;
    problemToSolve: string | null;
    idealOutcome: string | null;
    device: string | null;
    appVersion: string | null;
    appBuild: string | null;
    appPlatform: string | null;
    diagnostics: FeedbackEmailDiagnostics | null;
    source: string;
    consentVersion: 'product-feedback-v1';
    submissionStatus: string;
}

export interface FeedbackEmailConfig {
    apiKey: string;
    alertTo: string;
    alertFrom: string;
    submitterFrom: string;
    replyTo: string;
}

export interface RenderedFeedbackEmail {
    from: string;
    to: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
}

export type FeedbackDeliveryResult =
    | { outcome: 'sent'; providerMessageId: string }
    | { outcome: 'retry'; errorCode: string; retryAfterSeconds: number; terminal: boolean }
    | { outcome: 'dead'; errorCode: string };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ReadEnvironment = (name: string) => string | undefined;

const AREA_LABELS: Record<string, string> = {
    weather: 'Weather',
    charts_obs: 'Charts & observations',
    passage_planning: 'Passage planning',
    anchor_watch: 'Anchor Watch',
    voyage_log: 'Voyage log',
    crew_list: 'Crew List',
    vessel_nmea: 'Vessel & NMEA',
    account: 'Account',
    website: 'Website',
    other: 'Other',
};

const IMPACT_LABELS: Record<string, string> = {
    blocking: 'Stops me using it',
    serious: 'Serious',
    annoying: 'Annoying',
    cosmetic: 'Cosmetic',
    game_changer: 'Game changer',
    important: 'Important',
    nice_to_have: 'Nice to have',
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

function mailboxAddress(value: string): string | null {
    if (value.length > 320 || hasHeaderControl(value)) return null;
    if (isSafeEmailAddress(value)) return value;
    const match = value.match(/^([^<>]{1,100})\s*<([^<>]+)>$/u);
    const address = match?.[2]?.trim() ?? '';
    return match?.[1]?.trim() && isSafeEmailAddress(address) ? address : null;
}

function isSafeMailbox(value: string): boolean {
    return mailboxAddress(value) !== null;
}

/** Reuse the verified Founding Skipper Resend configuration; no new secret is required. */
export function readFeedbackEmailConfig(
    readEnvironment: ReadEnvironment = (name) => Deno.env.get(name),
): FeedbackEmailConfig | null {
    const apiKey = safeHeader(readEnvironment('RESEND_API_KEY'), 512);
    const alertTo = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_TO'), 254);
    const alertFrom = safeHeader(readEnvironment('FOUNDING_SKIPPER_ALERT_FROM'), 320);
    const configuredSubmitterFrom = safeHeader(readEnvironment('FOUNDING_SKIPPER_APPLICANT_FROM'), 320);
    const replyTo = safeHeader(readEnvironment('FOUNDING_SKIPPER_REPLY_TO'), 254);
    const submitterAddress = configuredSubmitterFrom ? mailboxAddress(configuredSubmitterFrom) : null;

    if (
        !apiKey ||
        !alertTo ||
        !alertFrom ||
        !submitterAddress ||
        !replyTo ||
        !isSafeEmailAddress(alertTo) ||
        !isSafeMailbox(alertFrom) ||
        !isSafeEmailAddress(replyTo)
    ) return null;

    // Reuse the already-verified sender mailbox, but replace the beta-program
    // display name so a product-feedback receipt is clearly identified.
    const submitterFrom = `Thalassa Feedback <${submitterAddress}>`;
    return { apiKey, alertTo, alertFrom, submitterFrom, replyTo };
}

export function escapeFeedbackEmailHtml(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

export function escapeFeedbackEmailText(value: string): string {
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
    return escapeFeedbackEmailHtml(escapeFeedbackEmailText(value)).replace(/\n/gu, '<br>');
}

function textValue(value: string): string {
    return escapeFeedbackEmailText(value).replace(/\n/gu, '\n  ');
}

function label(value: string, labels: Record<string, string>): string {
    return labels[value] ?? value;
}

function firstName(name: string): string {
    return name.trim().split(/\s+/u)[0]?.slice(0, 40) || 'Skipper';
}

function brandedHtml(title: string, content: string): string {
    return [
        '<!doctype html>',
        '<html lang="en"><body style="margin:0;padding:0;background:#eef7f8;">',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef7f8;">',
        '<tr><td align="center" style="padding:28px 14px;">',
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid #dbe7ea;border-radius:16px;overflow:hidden;">',
        '<tr><td style="height:7px;background:#0f766e;font-size:0;line-height:0;">&nbsp;</td></tr>',
        '<tr><td style="padding:30px 30px 12px;">',
        '<p style="margin:0 0 13px;color:#0f766e;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.2px;">THALASSA · PRODUCT FEEDBACK</p>',
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

function diagnosticsText(diagnostics: FeedbackEmailDiagnostics): string {
    return [
        `Platform: ${diagnostics.platform || 'Not reported'}`,
        `User agent: ${diagnostics.userAgent || 'Not reported'}`,
        `Screen: ${diagnostics.screen || 'Not reported'}`,
        `Viewport: ${diagnostics.viewport || 'Not reported'}`,
        `Language: ${diagnostics.language || 'Not reported'}`,
        `Online: ${diagnostics.online ? 'Yes' : 'No'}`,
        `Path: ${diagnostics.currentPath}`,
    ].join('\n');
}

function operatorValues(job: FeedbackEmailJob): ReadonlyArray<readonly [string, string]> {
    const common: Array<readonly [string, string]> = [
        ['Reference', job.reference],
        ['Type', job.kind === 'bug' ? 'Bug report' : 'Feature request'],
        ['Area', label(job.area, AREA_LABELS)],
        ['Impact', label(job.impact, IMPACT_LABELS)],
        ['Title', job.title],
        ['Details', job.details],
    ];
    if (job.kind === 'bug') {
        common.push(
            ['Steps to reproduce', job.stepsToReproduce || 'Not supplied'],
            ['Expected result', job.expectedResult || 'Not supplied'],
            ['Actual result', job.actualResult || 'Not supplied'],
        );
    } else {
        common.push(
            ['Problem to solve', job.problemToSolve || 'Not supplied'],
            ['Ideal outcome', job.idealOutcome || 'Not supplied'],
        );
    }
    common.push(
        ['Name', job.name],
        ['Email', job.email],
        ['Device', job.device || 'Not supplied'],
        ['Version', job.appVersion || 'Not supplied'],
        ['Build', job.appBuild || 'Not supplied'],
        ['Platform', job.appPlatform || 'Not supplied'],
        ['Diagnostics', job.diagnostics ? diagnosticsText(job.diagnostics) : 'Not shared'],
        ['Source', job.source],
    );
    return common;
}

function renderOperatorEmail(job: FeedbackEmailJob, config: FeedbackEmailConfig): RenderedFeedbackEmail {
    const values = operatorValues(job);
    const type = job.kind === 'bug' ? 'bug report' : 'feature request';
    const text = [
        `New Thalassa ${type}`,
        '',
        ...values.map(([name, value]) => `${name}: ${textValue(value)}`),
    ].join('\n');
    const content = [
        `<p style="margin:0 0 18px;">A new ${type} has come aboard.</p>`,
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">',
        ...values.map(([name, value]) => operatorRow(name, value)),
        '</table>',
    ].join('');

    return {
        from: config.alertFrom,
        to: config.alertTo,
        replyTo: job.email,
        subject: `New Thalassa ${type} · ${job.reference}`,
        html: brandedHtml(`New ${type}`, content),
        text,
    };
}

function renderSubmitterReceipt(job: FeedbackEmailJob, config: FeedbackEmailConfig): RenderedFeedbackEmail {
    const safeFirstName = htmlValue(firstName(job.name));
    const safeReference = htmlValue(job.reference);
    const type = job.kind === 'bug' ? 'bug report' : 'feature request';
    const content = [
        `<p style="margin:0 0 16px;">G&#39;day ${safeFirstName},</p>`,
        `<p style="margin:0 0 16px;">Thanks for sending your ${type}. It is safely aboard and ready for the Thalassa crew to review.</p>`,
        `<div style="margin:20px 0;padding:16px 18px;border-left:4px solid #14b8a6;background:#f0fdfa;border-radius:8px;"><strong>Reference ${safeReference}</strong></div>`,
        '<p style="margin:0 0 16px;">We read every report. We may reply if we need another detail, but this receipt does not promise a particular release or timeframe.</p>',
        '<p style="margin:0 0 16px;">If a screenshot or short screen recording would help, reply to this email and attach it; your reference will keep it connected to the report.</p>',
        '<p style="margin:22px 0 0;">Thanks for helping us make Thalassa better.<br><strong>The Thalassa crew</strong></p>',
    ].join('');
    const submitterName = firstName(job.name);
    const text = [
        `G'day ${escapeFeedbackEmailText(submitterName)},`,
        '',
        `Thanks for sending your ${type}. It is safely aboard and ready for the Thalassa crew to review.`,
        '',
        `Reference: ${job.reference}`,
        '',
        'We read every report. We may reply if we need another detail, but this receipt does not promise a particular release or timeframe.',
        '',
        'If a screenshot or short screen recording would help, reply to this email and attach it; your reference will keep it connected to the report.',
        '',
        'Thanks for helping us make Thalassa better.',
        'The Thalassa crew',
    ].join('\n');

    return {
        from: config.submitterFrom,
        to: job.email,
        replyTo: config.replyTo,
        subject: `We've received your Thalassa feedback · ${job.reference}`,
        html: brandedHtml("We've received your feedback", content),
        text,
    };
}

export function renderFeedbackEmail(job: FeedbackEmailJob, config: FeedbackEmailConfig): RenderedFeedbackEmail {
    return job.messageKind === 'operator_new_v1'
        ? renderOperatorEmail(job, config)
        : renderSubmitterReceipt(job, config);
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

export function classifyFeedbackResendFailure(
    status: number,
    attempts: number,
    retryAfterHeader: string | null = null,
): FeedbackDeliveryResult {
    if (status >= 400 && status < 500 && status !== 429) {
        return { outcome: 'dead', errorCode: `resend_http_${status}` };
    }
    return {
        outcome: 'retry',
        errorCode: status === 429 ? 'resend_rate_limited' : status >= 500 ? 'resend_unavailable' : 'resend_unexpected',
        retryAfterSeconds: boundedRetryAfter(retryAfterHeader) ?? retryDelay(attempts),
        terminal: attempts >= MAX_DELIVERY_ATTEMPTS,
    };
}

export async function deliverFeedbackEmail(
    job: FeedbackEmailJob,
    config: FeedbackEmailConfig | null,
    fetcher: FetchLike = fetch,
): Promise<FeedbackDeliveryResult> {
    if (!config) {
        return { outcome: 'retry', errorCode: 'email_not_configured', retryAfterSeconds: 300, terminal: false };
    }

    const rendered = renderFeedbackEmail(job, config);
    if (!isSafeMailbox(rendered.from) || !isSafeEmailAddress(rendered.to) || !isSafeEmailAddress(rendered.replyTo)) {
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
                'Idempotency-Key': `product-feedback/${job.submissionId}/${job.messageKind}/v1`,
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
            const result = classifyFeedbackResendFailure(
                response.status,
                job.attempts,
                response.headers.get('retry-after'),
            );
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
