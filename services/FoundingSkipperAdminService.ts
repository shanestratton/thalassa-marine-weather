import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import { supabase } from './supabase';
import {
    FOUNDING_SKIPPER_STATUSES,
    type FoundingSkipperApplicationRecord,
    type FoundingSkipperCursor,
    type FoundingSkipperPage,
    type FoundingSkipperStatus,
} from '../types/foundingSkippers';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BOAT_TYPES = new Set(['sail_monohull', 'sail_multihull', 'power', 'trailer_boat', 'other']);
const APPLE_DEVICES = new Set(['iphone', 'ipad', 'iphone_and_ipad']);
const FREQUENCIES = new Set(['weekly_plus', 'fortnightly', 'monthly', 'less_often']);
const STATUSES = new Set<string>(FOUNDING_SKIPPER_STATUSES);

export type FoundingSkipperAdminErrorCode =
    | 'not_configured'
    | 'not_signed_in'
    | 'not_authorized'
    | 'identity_changed'
    | 'load_failed'
    | 'stale_status';

export class FoundingSkipperAdminError extends Error {
    constructor(
        public readonly code: FoundingSkipperAdminErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'FoundingSkipperAdminError';
    }
}

function stringValue(value: unknown, maxLength: number): string | null {
    return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function timestamp(value: unknown): string | null {
    const candidate = stringValue(value, 64);
    return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function optionalTimestamp(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return timestamp(value) ?? undefined;
}

function optionalUuid(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

function parseApplication(value: unknown): FoundingSkipperApplicationRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const id = stringValue(row.id, 36);
    const name = stringValue(row.name, 80);
    const email = stringValue(row.email, 254);
    const boatType = stringValue(row.boat_type, 32);
    const homeWaters = stringValue(row.home_waters, 120);
    const appleDevice = stringValue(row.apple_device, 32);
    const boatingFrequency = stringValue(row.boating_frequency, 32);
    const source = stringValue(row.source, 40);
    const consentVersion = stringValue(row.consent_version, 64);
    const consentedAt = timestamp(row.consented_at);
    const status = stringValue(row.status, 20);
    const statusUpdatedAt = optionalTimestamp(row.status_updated_at);
    const statusUpdatedBy = optionalUuid(row.status_updated_by);
    const createdAt = timestamp(row.created_at);
    const expiresAt = timestamp(row.expires_at);
    const notes = row.notes === null ? null : stringValue(row.notes, 800);
    const interests = Array.isArray(row.interests)
        ? row.interests.filter((interest): interest is string => typeof interest === 'string' && interest.length <= 40)
        : null;

    if (
        !id ||
        !UUID.test(id) ||
        !name ||
        !email ||
        !boatType ||
        !BOAT_TYPES.has(boatType) ||
        !homeWaters ||
        !appleDevice ||
        !APPLE_DEVICES.has(appleDevice) ||
        !boatingFrequency ||
        !FREQUENCIES.has(boatingFrequency) ||
        !interests ||
        (notes === null && row.notes !== null) ||
        !source ||
        !consentVersion ||
        !consentedAt ||
        !status ||
        !STATUSES.has(status) ||
        statusUpdatedAt === undefined ||
        statusUpdatedBy === undefined ||
        !createdAt ||
        !expiresAt
    ) {
        return null;
    }

    return {
        id,
        name,
        email,
        boat_type: boatType as FoundingSkipperApplicationRecord['boat_type'],
        home_waters: homeWaters,
        apple_device: appleDevice as FoundingSkipperApplicationRecord['apple_device'],
        boating_frequency: boatingFrequency as FoundingSkipperApplicationRecord['boating_frequency'],
        interests,
        notes,
        source,
        consent_version: consentVersion,
        consented_at: consentedAt,
        status: status as FoundingSkipperStatus,
        status_updated_at: statusUpdatedAt,
        status_updated_by: statusUpdatedBy,
        created_at: createdAt,
        expires_at: expiresAt,
    };
}

async function captureAuthorizedIdentity() {
    if (!supabase) throw new FoundingSkipperAdminError('not_configured', 'Thalassa admin services are not configured.');
    const scope = getAuthIdentityScope();
    if (!scope.userId) throw new FoundingSkipperAdminError('not_signed_in', 'Sign in to review applications.');
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error || !user || user.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new FoundingSkipperAdminError('identity_changed', 'Your session changed. Reopen the admin panel.');
    }
    return scope;
}

function assertCurrent(scope: ReturnType<typeof getAuthIdentityScope>): void {
    if (!isAuthIdentityScopeCurrent(scope)) {
        throw new FoundingSkipperAdminError('identity_changed', 'Your session changed. Reopen the admin panel.');
    }
}

export const FoundingSkipperAdminService = {
    async canReview(): Promise<boolean> {
        const scope = await captureAuthorizedIdentity();
        const { data, error } = await supabase!.rpc('can_review_founding_skipper_applications');
        assertCurrent(scope);
        if (error) {
            throw new FoundingSkipperAdminError(
                error.code === '42501' ? 'not_authorized' : 'load_failed',
                error.code === '42501'
                    ? 'This account cannot review applications.'
                    : 'Applications could not be loaded.',
            );
        }
        return data === true;
    },

    async list(
        options: {
            status?: FoundingSkipperStatus | null;
            cursor?: FoundingSkipperCursor | null;
            limit?: number;
        } = {},
    ): Promise<FoundingSkipperPage> {
        const scope = await captureAuthorizedIdentity();
        const limit = Math.max(1, Math.min(PAGE_SIZE, Math.trunc(options.limit ?? PAGE_SIZE)));
        const { data, error } = await supabase!.rpc('list_founding_skipper_applications', {
            p_status: options.status ?? null,
            p_before_created_at: options.cursor?.createdAt ?? null,
            p_before_id: options.cursor?.id ?? null,
            p_limit: limit,
        });
        assertCurrent(scope);
        if (error) {
            const unauthorized =
                error.code === '42501' ||
                /not authorized|permission|forbidden|reviewer role required/iu.test(error.message ?? '');
            throw new FoundingSkipperAdminError(
                unauthorized ? 'not_authorized' : 'load_failed',
                unauthorized ? 'This account cannot review applications.' : 'Applications could not be loaded.',
            );
        }

        if (!Array.isArray(data)) {
            throw new FoundingSkipperAdminError('load_failed', 'Applications could not be loaded.');
        }
        const rows = data.map(parseApplication);
        if (rows.some((application) => application === null)) {
            throw new FoundingSkipperAdminError('load_failed', 'Applications could not be loaded safely.');
        }
        const applications = rows as FoundingSkipperApplicationRecord[];
        const last = applications.at(-1);
        return {
            applications,
            nextCursor: applications.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
        };
    },

    async review(
        applicationId: string,
        expectedStatus: FoundingSkipperStatus,
        status: FoundingSkipperStatus,
    ): Promise<void> {
        if (!UUID.test(applicationId) || !STATUSES.has(expectedStatus) || !STATUSES.has(status)) {
            throw new FoundingSkipperAdminError('load_failed', 'Invalid application review request.');
        }
        const scope = await captureAuthorizedIdentity();
        const { data, error } = await supabase!.rpc('review_founding_skipper_application', {
            p_application_id: applicationId,
            p_expected_status: expectedStatus,
            p_status: status,
        });
        assertCurrent(scope);
        if (error) {
            const unauthorized =
                error.code === '42501' ||
                /not authorized|permission|forbidden|reviewer role required/iu.test(error.message ?? '');
            throw new FoundingSkipperAdminError(
                unauthorized ? 'not_authorized' : 'load_failed',
                unauthorized ? 'This account cannot review applications.' : 'The status could not be updated.',
            );
        }
        if (data !== true) {
            throw new FoundingSkipperAdminError(
                'stale_status',
                'Someone changed this application first. Refresh before trying again.',
            );
        }
    },
};
