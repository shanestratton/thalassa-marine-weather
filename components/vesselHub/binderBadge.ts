/**
 * The Boat Binder's badges in words (131-B12; binder audit BH-2, BH-4).
 *
 * The Vessel page's Boat Binder row carries the single most urgent count from
 * inside the binder, so an overdue impeller or a lapsed paper shows without
 * opening it: overdue maintenance first, then expired papers (both red, both
 * past due), then papers expiring and warranties ending within 30 days
 * (amber). The row used to say "Inventory & reference" whatever was due.
 *
 * Pure, so it is tested on its own, and kept out of the counting hook so the
 * suites that replace that hook keep the real words.
 */
import type { VesselReadinessCounts } from '../../hooks/useVesselReadinessCounts';

export interface BinderBadge {
    count: number;
    /** The row's line, e.g. '2 maintenance tasks overdue'. */
    status: string;
    /** Red: past due. Amber otherwise. */
    urgent: boolean;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The most urgent count in the binder, or null when nothing is due. */
export function binderBadge(counts: VesselReadinessCounts): BinderBadge | null {
    const { overdueCount, expiredDocsCount, expiringDocsCount, expiringEquipCount } = counts;
    if (overdueCount > 0) {
        return {
            count: overdueCount,
            status: `${plural(overdueCount, 'maintenance task', 'maintenance tasks')} overdue`,
            urgent: true,
        };
    }
    if (expiredDocsCount > 0) {
        return {
            count: expiredDocsCount,
            status: `${plural(expiredDocsCount, 'document', 'documents')} expired`,
            urgent: true,
        };
    }
    if (expiringDocsCount > 0) {
        return {
            count: expiringDocsCount,
            status: `${plural(expiringDocsCount, 'document', 'documents')} expiring`,
            urgent: false,
        };
    }
    if (expiringEquipCount > 0) {
        return {
            count: expiringEquipCount,
            status: `${plural(expiringEquipCount, 'warranty', 'warranties')} ending soon`,
            urgent: false,
        };
    }
    return null;
}

/**
 * The Documents row's line, as the Documents header splits it: '1 expired ·
 * 1 expiring', either half alone, or null when every paper is in date.
 */
export function documentsDueStatus(expired: number, expiring: number): string | null {
    const parts = [expired > 0 ? `${expired} expired` : '', expiring > 0 ? `${expiring} expiring` : ''];
    return parts.filter(Boolean).join(' · ') || null;
}
