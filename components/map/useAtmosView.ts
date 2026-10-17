import { useLayoutEffect, useRef, useState } from 'react';
import { openAtmosSession, type AtmosSession, type AtmosView } from '../../services/weather/api/atmosSession';
import type { AtmosDataset } from '../../services/weather/api/atmosContract';

/** One caller-owned cohort, two decoded raw frames, one adopted selected-time view. */
export function useAtmosView(dataset: AtmosDataset | null, validMs: number | null, retry: number) {
    const latest = useRef({ dataset, validMs });
    latest.current = { dataset, validMs };
    const [session, setSession] = useState<AtmosSession | null>(null);
    const [view, setView] = useState<AtmosView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [refresh, setRefresh] = useState(0);

    useLayoutEffect(() => {
        setSession(null);
        setView(null);
        setError(null);
        setLoading(!!dataset);
        if (!dataset) return;
        const controller = new AbortController();
        let live = true,
            owned: AtmosSession | null = null;
        void openAtmosSession(dataset, controller.signal, () => live && latest.current.dataset === dataset)
            .then((result) => {
                owned = result;
                if (!live || controller.signal.aborted || !result.isCurrent()) {
                    result.close();
                    return;
                }
                setSession(result);
            })
            .catch((reason) => {
                if (!live) return;
                setError(reason instanceof Error ? reason.message : 'Atmospheric source unavailable');
                setLoading(false);
            });
        const timer = setTimeout(() => setRefresh((value) => value + 1), 20 * 60_000);
        return () => {
            live = false;
            clearTimeout(timer);
            owned?.close();
            controller.abort();
        };
    }, [dataset, retry, refresh]);

    useLayoutEffect(() => {
        setView(null);
        if (!dataset || !session || session.manifest.dataset !== dataset) return;
        if (validMs === null || !Number.isFinite(validMs)) {
            setError('Wind valid UTC is unknown; atmospheric overlay held');
            setLoading(false);
            return;
        }
        let live = true;
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        void session
            .readAt(validMs, controller.signal)
            .then((result) => {
                if (
                    !live ||
                    !result.isCurrent() ||
                    latest.current.dataset !== dataset ||
                    latest.current.validMs !== validMs
                )
                    return;
                setView(result);
                setLoading(false);
            })
            .catch((reason) => {
                if (!live) return;
                setView(null);
                setLoading(false);
                setError(reason instanceof Error ? reason.message : 'Atmospheric frame unavailable');
            });
        const check = () => {
            if (session.isCurrent()) return;
            setView(null);
            setLoading(false);
            setError('Atmospheric source expired or retired; retry');
        };
        const timer = setInterval(check, 1000);
        document.addEventListener('visibilitychange', check);
        return () => {
            live = false;
            controller.abort();
            clearInterval(timer);
            document.removeEventListener('visibilitychange', check);
        };
    }, [dataset, session, validMs]);

    const adopted = view && view.dataset === dataset && view.validMs === validMs && view.isCurrent() ? view : null;
    return { session, view: adopted, loading, error };
}
