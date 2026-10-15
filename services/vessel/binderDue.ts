/**
 * binderDue — what is really due in the Boat Binder, by the cards' own rules
 * (131-B12; binder audit BH-1, EQ-3, BH-2).
 *
 * Every day here is the skipper's local day (utils/localDate, 131-B11), so a
 * badge and the card it points at always agree. A paper is valid through the
 * end of its last day, reads "Expiring soon" for the 30 days before it, and
 * "Expired" after it, however long ago. A warranty is news only while it is
 * ending: in force today and over within those 30 days. The badge used to
 * count every expiry before a cutoff, so a warranty that ran out in 2019 read
 * "1 warranty ending soon" for ever, and an expired paper and one with three
 * weeks left were one "2 expiring".
 *
 * Pure, and free of the cards' React, so the Vessel page's badges read it
 * without loading the Documents or Equipment screens.
 */
import { localDaysUntil } from '../../utils/localDate';

export type ExpiryStatus = 'valid' | 'warning' | 'expired' | 'none';

/** Days before its expiry that a paper is "Expiring soon" and a warranty "ending soon". */
export const EXPIRY_WARNING_DAYS = 30;

/** A paper's state on its card: expired, expiring soon, valid, or no expiry. */
export function documentExpiryStatus(expiryDate: string | null | undefined, now: Date = new Date()): ExpiryStatus {
    const days = localDaysUntil(expiryDate, now);
    if (days === null) return 'none';
    if (days < 0) return 'expired';
    if (days < EXPIRY_WARNING_DAYS) return 'warning';
    return 'valid';
}

/** In force today and ending within the warning days; one long over is not "ending soon". */
export function warrantyEndingSoon(warrantyExpiry: string | null | undefined, now: Date = new Date()): boolean {
    const days = localDaysUntil(warrantyExpiry, now);
    return days !== null && days >= 0 && days < EXPIRY_WARNING_DAYS;
}

export interface DocumentsDue {
    /** Past their last day. */
    expired: number;
    /** Still valid, and expiring within the warning days. */
    expiring: number;
}

/** The papers that need the skipper, split as the Documents header splits them. */
export function documentsDue(
    documents: readonly { expiry_date?: string | null }[],
    now: Date = new Date(),
): DocumentsDue {
    let expired = 0;
    let expiring = 0;
    for (const document of documents) {
        const status = documentExpiryStatus(document.expiry_date, now);
        if (status === 'expired') expired++;
        else if (status === 'warning') expiring++;
    }
    return { expired, expiring };
}

/** How many warranties are ending soon. */
export function warrantiesEndingSoon(
    items: readonly { warranty_expiry?: string | null }[],
    now: Date = new Date(),
): number {
    return items.filter((item) => warrantyEndingSoon(item.warranty_expiry, now)).length;
}
