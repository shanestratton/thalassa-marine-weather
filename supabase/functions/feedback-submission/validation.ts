export const FEEDBACK_KINDS = ['bug', 'feature'] as const;
export const FEEDBACK_AREAS = [
    'weather',
    'charts_obs',
    'passage_planning',
    'anchor_watch',
    'voyage_log',
    'crew_list',
    'vessel_nmea',
    'account',
    'website',
    'other',
] as const;
export const BUG_IMPACTS = ['blocking', 'serious', 'annoying', 'cosmetic'] as const;
export const FEATURE_IMPACTS = ['game_changer', 'important', 'nice_to_have'] as const;
export const FEEDBACK_CONSENT_VERSION = 'product-feedback-v1' as const;

const ALLOWED_KEYS = new Set([
    'clientSubmissionId',
    'kind',
    'name',
    'email',
    'area',
    'title',
    'details',
    'impact',
    'stepsToReproduce',
    'expectedResult',
    'actualResult',
    'problemToSolve',
    'idealOutcome',
    'device',
    'appVersion',
    'appBuild',
    'appPlatform',
    'diagnostics',
    'source',
    'consent',
    'consentVersion',
    'website',
]);
const DIAGNOSTIC_KEYS = new Set([
    'platform',
    'userAgent',
    'screen',
    'viewport',
    'language',
    'online',
    'currentPath',
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SOURCE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENT_PATH = /^\/[^?#]{0,119}$/u;

export interface FeedbackDiagnostics {
    platform: string;
    userAgent: string;
    screen: string;
    viewport: string;
    language: string;
    online: boolean;
    currentPath: string;
}

export interface ValidatedProductFeedback {
    clientSubmissionId: string;
    kind: (typeof FEEDBACK_KINDS)[number];
    name: string;
    email: string;
    area: (typeof FEEDBACK_AREAS)[number];
    title: string;
    details: string;
    impact: (typeof BUG_IMPACTS)[number] | (typeof FEATURE_IMPACTS)[number];
    stepsToReproduce: string | null;
    expectedResult: string | null;
    actualResult: string | null;
    problemToSolve: string | null;
    idealOutcome: string | null;
    device: string | null;
    appVersion: string | null;
    appBuild: string | null;
    appPlatform: string | null;
    diagnostics: FeedbackDiagnostics | null;
    source: string;
    consentVersion: typeof FEEDBACK_CONSENT_VERSION;
    honeypotTriggered: boolean;
}

export interface FeedbackValidationResult {
    value: ValidatedProductFeedback | null;
    fields: string[];
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasInlineControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

function hasMultilineControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
    }
    return false;
}

function inline(value: unknown, min: number, max: number): string | null {
    if (typeof value !== 'string' || hasInlineControl(value)) return null;
    const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function optionalInline(value: unknown, max: number): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    return inline(value, 1, max) ?? undefined;
}

function multiline(value: unknown, min: number, max: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
    return normalized.length >= min && normalized.length <= max && !hasMultilineControl(normalized) ? normalized : null;
}

function optionalMultiline(value: unknown, max: number): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    return multiline(value, 1, max) ?? undefined;
}

function member<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
    return typeof value === 'string' && allowed.includes(value as T[number]) ? (value as T[number]) : null;
}

function diagnosticString(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').trim();
    return normalized.length <= max && !hasInlineControl(normalized) ? normalized : null;
}

function parseDiagnostics(value: unknown): FeedbackDiagnostics | null | undefined {
    if (value === undefined || value === null) return null;
    const input = record(value);
    if (!input || Object.keys(input).some((key) => !DIAGNOSTIC_KEYS.has(key)) || Object.keys(input).length !== 7) {
        return undefined;
    }

    const platform = diagnosticString(input.platform, 120);
    const userAgent = diagnosticString(input.userAgent, 512);
    const screen = diagnosticString(input.screen, 40);
    const viewport = diagnosticString(input.viewport, 40);
    const language = diagnosticString(input.language, 32);
    const currentPath = diagnosticString(input.currentPath, 120);
    if (
        platform === null ||
        userAgent === null ||
        screen === null ||
        viewport === null ||
        language === null ||
        currentPath === null ||
        !CURRENT_PATH.test(currentPath) ||
        typeof input.online !== 'boolean'
    ) {
        return undefined;
    }

    return {
        platform,
        userAgent,
        screen,
        viewport,
        language,
        online: input.online,
        currentPath,
    };
}

export function validateProductFeedback(body: Record<string, unknown>): FeedbackValidationResult {
    const fields: string[] = [];
    for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) fields.push('form');

    const clientSubmissionId = typeof body.clientSubmissionId === 'string'
        ? body.clientSubmissionId.trim().toLowerCase()
        : '';
    if (!UUID.test(clientSubmissionId)) fields.push('form');

    const kind = member(body.kind, FEEDBACK_KINDS);
    if (!kind) fields.push('kind');

    const name = inline(body.name, 2, 80);
    if (!name) fields.push('name');

    const rawEmail = inline(body.email, 3, 254);
    const email = rawEmail?.toLowerCase() ?? null;
    if (!email || !EMAIL.test(email)) fields.push('email');

    const area = member(body.area, FEEDBACK_AREAS);
    if (!area) fields.push('area');

    const title = inline(body.title, 5, 120);
    if (!title) fields.push('title');

    const details = multiline(body.details, 20, 4_000);
    if (!details) fields.push('details');

    const bugImpact = member(body.impact, BUG_IMPACTS);
    const featureImpact = member(body.impact, FEATURE_IMPACTS);
    const impact = kind === 'bug' ? bugImpact : kind === 'feature' ? featureImpact : null;
    if (!impact) fields.push('impact');

    const stepsToReproduce = optionalMultiline(body.stepsToReproduce, 2_000);
    const expectedResult = optionalMultiline(body.expectedResult, 2_000);
    const actualResult = optionalMultiline(body.actualResult, 2_000);
    const problemToSolve = optionalMultiline(body.problemToSolve, 2_000);
    const idealOutcome = optionalMultiline(body.idealOutcome, 2_000);
    if (stepsToReproduce === undefined) fields.push('stepsToReproduce');
    if (expectedResult === undefined) fields.push('expectedResult');
    if (actualResult === undefined) fields.push('actualResult');
    if (problemToSolve === undefined) fields.push('problemToSolve');
    if (idealOutcome === undefined) fields.push('idealOutcome');
    if (kind === 'bug' && (problemToSolve !== null || idealOutcome !== null)) fields.push('form');
    if (
        kind === 'feature' &&
        (stepsToReproduce !== null || expectedResult !== null || actualResult !== null)
    ) fields.push('form');

    const device = optionalInline(body.device, 120);
    const appVersion = optionalInline(body.appVersion, 40);
    const appBuild = optionalInline(body.appBuild, 40);
    const appPlatform = optionalInline(body.appPlatform, 40);
    if (device === undefined) fields.push('device');
    if (appVersion === undefined) fields.push('appVersion');
    if (appBuild === undefined) fields.push('appBuild');
    if (appPlatform === undefined) fields.push('appPlatform');

    const diagnostics = parseDiagnostics(body.diagnostics);
    if (diagnostics === undefined || (kind === 'feature' && diagnostics !== null)) fields.push('diagnostics');

    const sourceCandidate = typeof body.source === 'string' ? body.source.trim().toLowerCase() : 'direct';
    const source = SOURCE.test(sourceCandidate) ? sourceCandidate : null;
    if (!source) fields.push('source');

    if (body.consent !== true || body.consentVersion !== FEEDBACK_CONSENT_VERSION) fields.push('consent');
    if (body.website !== undefined && typeof body.website !== 'string') fields.push('form');
    const honeypotTriggered = typeof body.website === 'string' && body.website.trim().length > 0;

    const uniqueFields = [...new Set(fields)];
    if (
        uniqueFields.length > 0 ||
        !UUID.test(clientSubmissionId) ||
        !kind ||
        !name ||
        !email ||
        !area ||
        !title ||
        !details ||
        !impact ||
        stepsToReproduce === undefined ||
        expectedResult === undefined ||
        actualResult === undefined ||
        problemToSolve === undefined ||
        idealOutcome === undefined ||
        device === undefined ||
        appVersion === undefined ||
        appBuild === undefined ||
        appPlatform === undefined ||
        diagnostics === undefined ||
        !source
    ) {
        return { value: null, fields: uniqueFields };
    }

    return {
        value: {
            clientSubmissionId,
            kind,
            name,
            email,
            area,
            title,
            details,
            impact,
            stepsToReproduce,
            expectedResult,
            actualResult,
            problemToSolve,
            idealOutcome,
            device,
            appVersion,
            appBuild,
            appPlatform,
            diagnostics,
            source,
            consentVersion: FEEDBACK_CONSENT_VERSION,
            honeypotTriggered,
        },
        fields: [],
    };
}
