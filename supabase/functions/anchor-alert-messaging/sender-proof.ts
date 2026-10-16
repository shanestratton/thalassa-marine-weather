import { shoreEmail, shoreRecord, shoreUuid } from '../../../utils/shoreContacts.ts';
import { boundedFetch, type Environment } from './transport.ts';

export interface SenderProof {
    configured: boolean;
    senderVerified: boolean;
    check: 'not_configured' | 'unavailable' | 'read_denied' | 'incomplete' | 'unverified' | 'verified';
    checkedAt: number;
}

/** Service-only deployment review; GETs domain metadata and never sends mail.
 * https://resend.com/docs/api-reference/domains/list-domains
 * A verified exact domain with sending enabled proves this narrow capability,
 * not a contractual entitlement, recipient consent or message delivery. */
export async function readEmailSenderProof(env: Environment, fetcher = fetch): Promise<SenderProof> {
    const from = env.get('FOUNDING_SKIPPER_APPLICANT_FROM'), key = env.get('RESEND_API_KEY');
    const mailbox = from?.includes('<') ? from.match(/^[^<>\r\n]{1,80} <([^<>\s]+@[^<>\s]+)>$/)?.[1] : from;
    const result = (check: SenderProof['check']): SenderProof => ({
        configured: check !== 'not_configured',
        senderVerified: check === 'verified',
        check,
        checkedAt: Date.now(),
    });
    if (!shoreEmail(mailbox) || !key || key.length > 256 || /\s/.test(key)) return result('not_configured');
    const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1).toLowerCase();
    let after: string | undefined;
    const cursors = new Set<string>();
    try {
        for (let page = 0; page < 2; page++) {
            const url = new URL('https://api.resend.com/domains');
            url.searchParams.set('limit', '25');
            if (after) url.searchParams.set('after', after);
            const response = await boundedFetch(fetcher, url.href, {
                method: 'GET',
                headers: { authorization: `Bearer ${key}` },
            });
            if (response.status === 401 || response.status === 403) return result('read_denied');
            const body = response.body;
            if (
                response.status !== 200 || !shoreRecord(body) || body.object !== 'list' ||
                typeof body.has_more !== 'boolean' || !Array.isArray(body.data) || body.data.length > 25
            ) return result('unavailable');
            for (const item of body.data) {
                if (!shoreRecord(item) || !shoreUuid(item.id) || typeof item.name !== 'string') {
                    return result('unavailable');
                }
                if (
                    item.name.toLowerCase() === domain && item.status === 'verified' &&
                    shoreRecord(item.capabilities) && item.capabilities.sending === 'enabled'
                ) return result('verified');
            }
            if (!body.has_more) return result('unverified');
            const last = body.data.at(-1);
            if (!shoreRecord(last) || !shoreUuid(last.id) || cursors.has(last.id)) return result('unavailable');
            after = last.id;
            cursors.add(after);
        }
        return result('incomplete');
    } catch {
        return result('unavailable');
    }
}
