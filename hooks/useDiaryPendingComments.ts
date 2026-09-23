import { useCallback, useEffect, useState } from 'react';
import { listPendingDiaryCommentCounts, subscribeDiaryCommentChanges } from '../services/DiaryCommentService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';

/** Only mounted with Diary. No persistent badge cache or per-card requests. */
export function useDiaryPendingComments(entryIds: readonly string[], enabled: boolean) {
    const idsKey = JSON.stringify([...new Set(entryIds.filter((id) => id && !id.startsWith('offline-')))].sort());
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision((value) => value + 1), []);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                setCounts({});
                setError('');
                refresh();
            }),
        [refresh],
    );

    useEffect(() => {
        const scope = getAuthIdentityScope();
        const ids: string[] = JSON.parse(idsKey);
        if (!enabled || !scope.userId || !ids.length) return;
        let active = true;
        let controller: AbortController | null = null;
        let request = 0;
        const load = async (replaceInFlight = false) => {
            if (document.hidden || (controller && !replaceInFlight)) return;
            controller?.abort();
            const current = new AbortController();
            controller = current;
            const version = ++request;
            const timeout = setTimeout(() => current.abort(), 15_000);
            try {
                const next = await listPendingDiaryCommentCounts(ids, current.signal);
                if (active && version === request && isAuthIdentityScopeCurrent(scope)) {
                    setCounts(next);
                    setError('');
                }
            } catch {
                // Retain last-known highlights on a transient connection failure;
                // absence of connectivity must not imply everything was reviewed.
                if (active && version === request && isAuthIdentityScopeCurrent(scope))
                    setError('Comment checks unavailable');
            } finally {
                clearTimeout(timeout);
                if (controller === current) controller = null;
            }
        };
        const onResume = () => {
            void load();
        };
        const unsubscribe = subscribeDiaryCommentChanges(() => {
            void load(true);
        });
        document.addEventListener('visibilitychange', onResume);
        window.addEventListener('focus', onResume);
        window.addEventListener('online', onResume);
        const timer = setInterval(onResume, 60_000);
        void load();
        return () => {
            active = false;
            controller?.abort();
            unsubscribe();
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onResume);
            window.removeEventListener('focus', onResume);
            window.removeEventListener('online', onResume);
        };
    }, [enabled, idsKey, revision]);

    return { counts, error, refresh };
}
