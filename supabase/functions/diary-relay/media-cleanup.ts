/** Exact, owner-scoped Storage cleanup driven by the durable deletion manifest. */
export type DiaryMediaBucket = 'diary-photos' | 'diary-audio' | 'diary-video';
export interface DiaryMediaReference {
    bucket: DiaryMediaBucket;
    reference: string;
}

export interface DiaryMediaCleanupGateway {
    isReferenced(bucket: DiaryMediaBucket, path: string): Promise<boolean>;
    remove(bucket: DiaryMediaBucket, path: string): Promise<void>;
    acknowledge(reference: DiaryMediaReference, removedPath: string | null): Promise<void>;
}

const BUCKETS = new Set(['diary-photos', 'diary-audio', 'diary-video']);

export function ownedDiaryMediaPath(
    item: DiaryMediaReference,
    ownerId: string,
    storageOrigin: string,
): string | null {
    const storagePrefix = `storage:${item.bucket}:`;
    let path: string;
    if (item.reference.startsWith(storagePrefix)) {
        path = item.reference.slice(storagePrefix.length);
    } else {
        try {
            const url = new URL(item.reference);
            if (url.origin !== new URL(storageOrigin).origin || url.username || url.password) return null;
            const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
            if (!match || match[1] !== item.bucket) return null;
            path = decodeURIComponent(match[2]);
            // Reject URL normalization of a traversal-looking raw reference.
            if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(item.reference.split(/[?#]/, 1)[0])) return null;
        } catch {
            return null;
        }
    }
    if (
        !path.startsWith(`${ownerId}/`) ||
        path.length > 1_024 ||
        path.includes('\\') ||
        [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) return null;
    return path;
}

export async function cleanupCancelledDiaryMedia(
    manifest: unknown,
    ownerId: string,
    storageOrigin: string,
    gateway: DiaryMediaCleanupGateway,
): Promise<void> {
    // Validate the whole manifest before any side effect. An old RPC response
    // without a manifest must fail, otherwise a rollout would falsely report
    // that media was removed by the old row-only cancellation implementation.
    if (!Array.isArray(manifest)) throw new Error('Diary cancellation returned no media manifest');
    for (const item of manifest) {
        if (
            !item || typeof item !== 'object' ||
            !BUCKETS.has(item.bucket) || typeof item.reference !== 'string'
        ) throw new Error('Diary cancellation returned an invalid media manifest');
    }

    for (const item of manifest as DiaryMediaReference[]) {
        const path = ownedDiaryMediaPath(item, ownerId, storageOrigin);
        if (path === null || await gateway.isReferenced(item.bucket, path)) {
            // An external/device-local reference has no owned object to delete.
            // A surviving diary assumes responsibility for shared media.
            await gateway.acknowledge(item, null);
            continue;
        }
        await gateway.remove(item.bucket, path);
        // The RPC verifies catalog absence, so a misleading partial Storage
        // success leaves this reference queued just like a transport failure.
        await gateway.acknowledge(item, path);
    }
}
