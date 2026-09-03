/**
 * Mount-time probe effects for the voice console, lifted out of
 * BosunConsole.tsx one-for-one. Each hook is a single useEffect and is
 * called from the same position in the component body, so hook order and
 * effect order are unchanged.
 *
 * The dependency arrays below are the originals plus the ref / setState
 * identities the extraction made visible to react-hooks/exhaustive-deps.
 * React guarantees both are stable for the component's lifetime, so the
 * arrays are unchanged in effect.
 */
import { type Dispatch, type SetStateAction, useEffect } from 'react';
import { isBosunReachable } from '../../../services/voice/bosunVoice';
import { isSpeechRecognitionAvailable } from '../../../services/voice/speechRecognizer';
import { checkCloudReachable } from './helpers';
import { ENABLE_APPLE_SR_FALLBACK } from './types';

export function useReachabilityProbe(
    setBosunAvailable: Dispatch<SetStateAction<boolean | null>>,
    setCloudAvailable: Dispatch<SetStateAction<boolean | null>>,
): void {
    // Probe availability when console opens + every 30s
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        let cancelled = false;
        const probe = async () => {
            const [bosun, cloud] = await Promise.all([isBosunReachable(), checkCloudReachable()]);
            if (!cancelled) {
                setBosunAvailable(bosun);
                setCloudAvailable(cloud);
            }
        };
        void probe();
        const interval = setInterval(probe, 30_000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [setBosunAvailable, setCloudAvailable]);
}

export function useAppleSrStatusProbe(
    setSrStatus: Dispatch<SetStateAction<'unknown' | 'available' | 'denied' | 'unsupported' | 'error'>>,
    setSrStatusError: Dispatch<SetStateAction<string | null>>,
): void {
    // Probe SR availability on console open. Surfaces the result in the
    // header pill so the skipper doesn't need Web Inspector or Xcode logs
    // to tell whether the on-device fast-path is going to be in play.
    //
    // Skipped entirely when ENABLE_APPLE_SR_FALLBACK is false — calling
    // even the availability check on Apple's SFSpeechRecognizer API
    // counts against iOS's per-device rate limit and can lock the
    // audio session for 30-60 minutes if quota was already low.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        if (!ENABLE_APPLE_SR_FALLBACK) {
            // Don't even ask iOS about SR — keep the audio system clean.
            setSrStatus('unsupported');
            setSrStatusError('Apple SR disabled by feature flag');
            return;
        }
        let cancelled = false;
        const probe = async () => {
            try {
                const available = await isSpeechRecognitionAvailable(true);
                if (cancelled) return;
                if (available) {
                    setSrStatus('available');
                    setSrStatusError(null);
                } else {
                    // Distinguish "unsupported" from "denied" by re-checking
                    // permission state directly. If the bridge throws, the
                    // catch below sets 'unsupported'.
                    try {
                        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
                        const status = await SpeechRecognition.checkPermissions();
                        if (cancelled) return;
                        setSrStatus(status.speechRecognition === 'denied' ? 'denied' : 'unsupported');
                        setSrStatusError(null);
                    } catch (err) {
                        if (cancelled) return;
                        setSrStatus('unsupported');
                        setSrStatusError((err as Error).message);
                    }
                }
            } catch (err) {
                if (cancelled) return;
                setSrStatus('error');
                setSrStatusError((err as Error).message);
            }
        };
        void probe();
        return () => {
            cancelled = true;
        };
    }, [setSrStatus, setSrStatusError]);
}

export function useStorageDiagnosticsProbe(
    showVoiceDiagnostics: boolean,
    setSrEventLog: Dispatch<SetStateAction<Array<{ ts: number; msg: string }>>>,
): void {
    // localStorage usage probe on console open. iOS WKWebView caps
    // localStorage at ~5 MB per origin; once full, setItem() throws
    // verbatim "The quota has been exceeded." which has been
    // confusing the skipper. Logging the size + breakdown to the
    // debug strip lets us see at a glance whether storage pressure
    // is the actual cause.
    useEffect(() => {
        // BosunConsole now mounts/unmounts via the page registry, so the
        // legacy isOpen guard is redundant — effects always run on mount.
        // The probe copies every stored value, so only pay for it when the
        // diagnostics strip that shows the result is actually on.
        if (!showVoiceDiagnostics) return;
        try {
            let total = 0;
            const big: Array<{ key: string; size: number }> = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k === null) continue;
                const v = localStorage.getItem(k) ?? '';
                const size = k.length + v.length;
                total += size;
                if (size > 50_000) big.push({ key: k, size });
            }
            big.sort((a, b) => b.size - a.size);
            const totalKb = (total / 1024).toFixed(0);
            const topKeys =
                big
                    .slice(0, 3)
                    .map((b) => `${b.key.slice(0, 22)}=${(b.size / 1024).toFixed(0)}KB`)
                    .join(', ') || '(none >50KB)';
            setSrEventLog((prev) => [
                ...prev.slice(-19),
                { ts: Date.now(), msg: `[storage] total=${totalKb}KB; top: ${topKeys}` },
            ]);
        } catch (err) {
            setSrEventLog((prev) => [
                ...prev.slice(-19),
                { ts: Date.now(), msg: `[storage] probe failed: ${(err as Error).message}` },
            ]);
        }
    }, [showVoiceDiagnostics, setSrEventLog]);
}
