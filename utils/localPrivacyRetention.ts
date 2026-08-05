/**
 * Retention and exact-owner helpers for non-replayable local quarantine data.
 *
 * Quarantine is a privacy fence, not a second offline database. It may retain
 * enough malformed legacy data to diagnose a migration, but it must not grow
 * forever or become an undeletable copy of a former account.
 */

export const LOCAL_QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCAL_QUARANTINE_MAX_ENTRIES = 64;
export const LOCAL_QUARANTINE_MAX_BYTES = 256 * 1024;

const TIMESTAMP_FIELDS = ['quarantinedAt', 'quarantined_at', 'createdAt', 'created_at'] as const;
const OWNER_ID_FIELDS = ['owner_user_id', 'ownerUserId', 'user_id'] as const;
const OWNER_SCOPE_FIELDS = ['ownerKey', 'owner_key', 'scopeKey', 'scope_key', 'scoped_key'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
    const serialized = JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).byteLength;
    // UTF-16 is a conservative fallback where TextEncoder is unavailable.
    return serialized.length * 2;
}

function quarantineTimestamp(value: unknown, fallback: number): number {
    if (!isRecord(value)) return fallback;
    for (const field of TIMESTAMP_FIELDS) {
        const candidate = value[field];
        const parsed =
            typeof candidate === 'number'
                ? candidate
                : typeof candidate === 'string'
                  ? Date.parse(candidate)
                  : Number.NaN;
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function compactOversizeEntry(value: unknown, originalBytes: number, now: number): Record<string, unknown> {
    const source = isRecord(value) ? value : {};
    const compact: Record<string, unknown> = {
        quarantined_at: new Date(quarantineTimestamp(value, now)).toISOString(),
        reason: typeof source.reason === 'string' ? source.reason.slice(0, 512) : 'oversize legacy quarantine',
        payload_omitted: true,
        original_bytes: originalBytes,
    };
    for (const field of [...OWNER_ID_FIELDS, ...OWNER_SCOPE_FIELDS, 'sourceKey', 'kind'] as const) {
        const candidate = source[field];
        if (typeof candidate === 'string' || candidate === null) compact[field] = candidate;
    }
    return compact;
}

/**
 * Return a newest-first-retained quarantine array bounded by age, count and
 * serialized byte size. A pre-array legacy object is treated as one entry.
 */
export function boundedLocalQuarantine(
    existing: unknown,
    additions: readonly unknown[] = [],
    now = Date.now(),
): unknown[] {
    const existingEntries = Array.isArray(existing) ? existing : existing == null ? [] : [existing];
    const cutoff = now - LOCAL_QUARANTINE_TTL_MS;
    let retained = [...existingEntries, ...additions]
        .map((entry) => ({
            entry,
            // Timestamp-less legacy entries have no defensible retention
            // window. Writers stamp every new entry, so retire those bytes.
            timestamp: quarantineTimestamp(entry, 0),
        }))
        .filter(({ timestamp }) => timestamp >= cutoff && timestamp <= now + 5 * 60 * 1000)
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-LOCAL_QUARANTINE_MAX_ENTRIES)
        .map(({ entry }) => {
            const size = serializedBytes(entry);
            return size <= LOCAL_QUARANTINE_MAX_BYTES ? entry : compactOversizeEntry(entry, size, now);
        });

    while (retained.length > 0 && serializedBytes(retained) > LOCAL_QUARANTINE_MAX_BYTES) {
        retained = retained.slice(1);
    }
    return retained;
}

function ownerIdFromScopeMarker(value: unknown): string | null | undefined {
    if (typeof value !== 'string') return value === null ? null : undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized === 'anonymous') return null;
    if (normalized.startsWith('user:')) return normalized.slice('user:'.length).trim() || undefined;

    const separator = normalized.lastIndexOf('::');
    if (separator < 0) return undefined;
    try {
        const scope = decodeURIComponent(normalized.slice(separator + 2));
        return scope.startsWith('user:') ? scope.slice('user:'.length).trim() || undefined : null;
    } catch {
        return undefined;
    }
}

function explicitOwnerIds(record: Record<string, unknown>): Array<string | null> {
    const owners: Array<string | null> = [];
    for (const field of OWNER_ID_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
        const candidate = record[field];
        if (candidate === null) owners.push(null);
        else if (typeof candidate === 'string' && candidate.trim() && candidate.trim() !== 'local') {
            owners.push(candidate.trim());
        }
    }
    for (const field of OWNER_SCOPE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
        const owner = ownerIdFromScopeMarker(record[field]);
        if (owner !== undefined) owners.push(owner);
    }
    return owners;
}

function containsConflictingOwner(value: unknown, expectedUserId: string): boolean {
    if (Array.isArray(value)) return value.some((entry) => containsConflictingOwner(entry, expectedUserId));
    if (!isRecord(value)) return false;
    const owners = explicitOwnerIds(value);
    if (owners.some((owner) => owner !== expectedUserId)) return true;
    return Object.values(value).some((entry) => containsConflictingOwner(entry, expectedUserId));
}

export interface OwnedValueScrubResult {
    value: unknown;
    removed: unknown[];
    changed: boolean;
}

const REMOVED = Symbol('removed-owned-local-value');

/**
 * Remove only nodes whose explicit ownership evidence unanimously names the
 * deleted user. Conflicting or different-account markers preserve the whole
 * node, preventing a malformed mixed record from deleting another account.
 */
export function removeLocalValuesOwnedBy(value: unknown, userId: string): OwnedValueScrubResult {
    const normalizedUserId = userId.trim();
    const removed: unknown[] = [];

    const visit = (candidate: unknown): unknown | typeof REMOVED => {
        if (Array.isArray(candidate)) {
            let changed = false;
            const next: unknown[] = [];
            for (const entry of candidate) {
                const visited = visit(entry);
                if (visited === REMOVED) changed = true;
                else {
                    if (visited !== entry) changed = true;
                    next.push(visited);
                }
            }
            return changed ? next : candidate;
        }
        if (!isRecord(candidate)) return candidate;

        const owners = explicitOwnerIds(candidate);
        if (owners.length > 0) {
            if (
                owners.every((owner) => owner === normalizedUserId) &&
                !Object.values(candidate).some((entry) => containsConflictingOwner(entry, normalizedUserId))
            ) {
                removed.push(candidate);
                return REMOVED;
            }
            // An explicit anonymous/different/conflicting owner fences the
            // complete record from recursive deletion.
            return candidate;
        }

        let changed = false;
        const next: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(candidate)) {
            const visited = visit(entry);
            if (visited === REMOVED) changed = true;
            else {
                if (visited !== entry) changed = true;
                next[key] = visited;
            }
        }
        return changed ? next : candidate;
    };

    const visited = visit(value);
    return {
        value: visited === REMOVED ? null : visited,
        removed,
        changed: visited === REMOVED || visited !== value,
    };
}

export function isEmptyLocalValue(value: unknown): boolean {
    return (
        value === null ||
        (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0)
    );
}
