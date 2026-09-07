import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPublicInstruments, VoyageLogError, type PublicInstrumentResponse } from './voyageLogApi';

const REFRESH_MS = 10_000;
const TIMEOUT_MS = 12_000;
const pageVisible = () => document.visibilityState !== 'hidden';

/** Ordered full/light responses share one consent authority. Sensor source clocks
 * remain untouched: a successful refresh is not a new measurement. */
export function usePublicInstrumentFeed(handle: string | null, enabled: boolean) {
    const sequence = useRef(0);
    const applied = useRef(0);
    const [snapshot, setSnapshot] = useState<PublicInstrumentResponse | null>(null);
    const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);
    const retryUntil = useRef(0);
    const beginRequest = useCallback(() => ++sequence.current, []);
    const acceptResponse = useCallback((id: number, data: PublicInstrumentResponse) => {
        if (id <= applied.current) return;
        applied.current = id;
        setSnapshot({
            instruments_shared: data.instruments_shared === true,
            instruments: data.instruments_shared === true ? (data.instruments ?? null) : null,
            generated_at: data.generated_at,
        });
        setLastSuccessfulAt(Date.now());
        setFailed(false);
    }, []);

    useEffect(() => {
        if (!enabled || !handle) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let controller: AbortController | null = null;
        const poll = async () => {
            if (disposed || !pageVisible() || controller) return;
            if (Date.now() < retryUntil.current) {
                timer = setTimeout(() => void poll(), retryUntil.current - Date.now());
                return;
            }
            const id = beginRequest();
            const request = new AbortController();
            controller = request;
            const requestTimeout = setTimeout(() => request.abort(), TIMEOUT_MS);
            timeout = requestTimeout;
            try {
                const response = await fetchPublicInstruments(handle, request.signal);
                if (!disposed && !request.signal.aborted) acceptResponse(id, response);
            } catch (error) {
                if (!disposed && controller === request) {
                    if (id > applied.current) setFailed(true);
                    if (error instanceof VoyageLogError) {
                        if (error.status === 403 || error.status === 404) {
                            acceptResponse(id, { instruments_shared: false, instruments: null, generated_at: '' });
                        }
                        if (error.status === 429 || error.status === 503) {
                            retryUntil.current =
                                Date.now() + Math.min(3_600_000, Math.max(60_000, error.retryAfterMs ?? 60_000));
                        }
                    }
                }
            } finally {
                clearTimeout(requestTimeout);
                const current = controller === request;
                if (current) controller = null;
                if (!disposed && current && pageVisible()) {
                    timer = setTimeout(() => void poll(), Math.max(REFRESH_MS, retryUntil.current - Date.now()));
                }
            }
        };
        const visibilityChanged = () => {
            clearTimeout(timer);
            if (document.visibilityState === 'hidden') {
                controller?.abort();
                controller = null;
            } else void poll();
        };
        void poll();
        document.addEventListener('visibilitychange', visibilityChanged);
        return () => {
            disposed = true;
            clearTimeout(timer);
            clearTimeout(timeout);
            controller?.abort();
            document.removeEventListener('visibilitychange', visibilityChanged);
        };
    }, [acceptResponse, beginRequest, enabled, handle]);

    return { snapshot, lastSuccessfulAt, failed, beginRequest, acceptResponse };
}
