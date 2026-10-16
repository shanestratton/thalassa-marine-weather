import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { withTimeout } from '../utils/deadline';
import {
    parseShoreConfiguration,
    shoreUuid,
    shoreRecord,
    type ShoreContactSummary,
    type ShoreContactConfiguration,
} from '../utils/shoreContacts';
export interface ShoreContactsList {
    schema: 1;
    ownerId: string;
    boatId: string;
    checkedAt: number;
    emailReady: boolean;
    telegramReady: boolean;
    overdueReady?: boolean;
    contacts: ShoreContactSummary[];
}
export function parseShoreContacts(
    value: unknown,
    boat: string,
    scope: AuthIdentityScope,
    now = Date.now(),
): ShoreContactsList | null {
    if (
        !shoreRecord(value) ||
        value.schema !== 1 ||
        value.ownerId !== scope.userId ||
        value.boatId !== boat ||
        typeof value.emailReady !== 'boolean' ||
        typeof value.telegramReady !== 'boolean' ||
        (Object.hasOwn(value, 'overdueReady') && typeof value.overdueReady !== 'boolean') ||
        typeof value.checkedAt !== 'number' ||
        !Number.isSafeInteger(value.checkedAt) ||
        value.checkedAt > now ||
        now - value.checkedAt > 60_000 ||
        !Array.isArray(value.contacts) ||
        value.contacts.length > 10 ||
        Object.keys(value).some(
            (k) =>
                ![
                    'schema',
                    'ownerId',
                    'boatId',
                    'checkedAt',
                    'emailReady',
                    'telegramReady',
                    'overdueReady',
                    'contacts',
                ].includes(k),
        )
    )
        return null;
    const ids = new Set<string>();
    for (const r of value.contacts) {
        if (
            !shoreRecord(r) ||
            !shoreUuid(r.id) ||
            !shoreUuid(r.revision) ||
            ids.has(r.id) ||
            !parseShoreConfiguration(r.configuration) ||
            !['pending', 'confirmed', 'revoked'].includes(String(r.consent)) ||
            Object.keys(r).some((k) => !['id', 'revision', 'configuration', 'consent', 'consentedAt'].includes(k)) ||
            (r.consent === 'confirmed'
                ? typeof r.consentedAt !== 'number' ||
                  !Number.isSafeInteger(r.consentedAt) ||
                  r.consentedAt > value.checkedAt ||
                  r.consentedAt <= 0
                : r.consentedAt !== null)
        )
            return null;
        ids.add(r.id);
    }
    return value as unknown as ShoreContactsList;
}
function current(boat: string, scope: AuthIdentityScope): boolean {
    return (
        !!supabase && !!scope.userId && shoreUuid(boat) && isAuthIdentityScopeCurrent(scope) && !satelliteModeActive()
    );
}
export async function listShoreContacts(
    boat: string,
    scope = getAuthIdentityScope(),
): Promise<ShoreContactsList | null> {
    if (!current(boat, scope)) return null;
    try {
        const r = await withTimeout(
            Promise.resolve(supabase!.rpc('shore_contacts_list', { p_boat_id: boat })),
            null,
            5000,
        );
        return current(boat, scope) && r && !r.error ? parseShoreContacts(r.data, boat, scope) : null;
    } catch {
        return null;
    }
}
export async function configureShoreContact(
    boat: string,
    row: Pick<ShoreContactSummary, 'id' | 'revision'> | null,
    cfg: ShoreContactConfiguration | null,
    scope: AuthIdentityScope,
): Promise<void> {
    if (
        !current(boat, scope) ||
        (row && (!shoreUuid(row.id) || !shoreUuid(row.revision))) ||
        (cfg !== null && !parseShoreConfiguration(cfg)) ||
        (!row && !cfg)
    )
        throw new Error('Review the current owned vessel online.');
    const r = await withTimeout(
        Promise.resolve(
            supabase!.rpc('configure_shore_contact', {
                p_boat_id: boat,
                p_contact_id: row?.id ?? null,
                p_expected: row?.revision ?? null,
                p_configuration: cfg,
            }),
        ),
        null,
        5000,
    );
    if (!current(boat, scope)) throw new Error('Account or network policy changed.');
    if (r?.error?.code === '40001')
        throw new Error('Changed on another phone. Reload and review; nothing was retried.');
    if (!r || r.error || !shoreUuid(r.data))
        throw new Error('Recipient consent, vessel/source or delivery capability is unavailable.');
}
export async function inviteShoreContact(
    boat: string,
    row: ShoreContactSummary,
    scope: AuthIdentityScope,
): Promise<string | null> {
    if (!current(boat, scope) || !shoreUuid(row.id) || !shoreUuid(row.revision))
        throw new Error('Review the current owned contact online.');
    const r = await withTimeout(
        supabase!.functions.invoke('anchor-alert-messaging', {
            body: { action: 'invite', contactId: row.id, revision: row.revision },
        }),
        null,
        8000,
    );
    if (!current(boat, scope)) throw new Error('Account changed.');
    if (!r || r.error || !shoreRecord(r.data))
        throw new Error('Invitation was not confirmed accepted. Reload before trying again.');
    if (row.configuration.channel === 'email' && r.data.invitationAccepted === true) return null;
    if (
        row.configuration.channel === 'telegram' &&
        typeof r.data.invitationUrl === 'string' &&
        /^https:\/\/t\.me\/\w{5,32}bot\?start=[a-f\d]{64}$/i.test(r.data.invitationUrl)
    )
        return r.data.invitationUrl;
    throw new Error('Invalid invitation response.');
}
export async function bindShoreAnchor(
    boat: string,
    session: string,
    expected: string | null,
    scope: AuthIdentityScope,
): Promise<string> {
    if (!current(boat, scope) || !/^[A-HJ-NP-Z2-9]{12}$/.test(session) || (expected !== null && !shoreUuid(expected)))
        throw new Error('Review the current owned anchor session.');
    const r = await withTimeout(
        Promise.resolve(
            supabase!.rpc('bind_shore_anchor', { p_boat_id: boat, p_session_code: session, p_expected: expected }),
        ),
        null,
        5000,
    );
    if (!current(boat, scope) || !r || r.error || !shoreUuid(r.data))
        throw new Error('Session changed or is not a current owned vessel watch.');
    return r.data;
}
