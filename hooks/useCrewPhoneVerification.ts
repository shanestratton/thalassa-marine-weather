import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
    CrewPhoneVerificationError,
    CrewPhoneVerificationService,
    type CrewPhoneVerificationPending,
    type CrewPhoneVerificationStatus,
} from '../services/CrewPhoneVerificationService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';

const subscribeIdentity = (onStoreChange: () => void): (() => void) =>
    subscribeAuthIdentityScope(() => onStoreChange());

function publicErrorMessage(error: unknown): string {
    if (error instanceof CrewPhoneVerificationError) return error.message;
    return 'Phone verification could not be completed. Please try again.';
}

function retrySeconds(error: unknown): number | undefined {
    return error instanceof CrewPhoneVerificationError ? error.retryAfterSeconds : undefined;
}

export interface CrewPhoneVerificationController {
    signedIn: boolean;
    loading: boolean;
    status: CrewPhoneVerificationStatus | null;
    pending: CrewPhoneVerificationPending | null;
    publicationState: 'checking' | 'ready' | 'blocked' | 'unavailable';
    publicationReady: boolean;
    countryCode: string;
    localNumber: string;
    code: string;
    error: string;
    starting: boolean;
    checking: boolean;
    removing: boolean;
    cooldownSeconds: number;
    setCountryCode: (countryCode: string) => void;
    setLocalNumber: (phone: string) => void;
    setCode: (code: string) => void;
    start: () => Promise<void>;
    check: () => Promise<void>;
    resend: () => Promise<void>;
    changeNumber: () => void;
    remove: () => Promise<void>;
    refresh: () => Promise<void>;
}

export function useCrewPhoneVerification(): CrewPhoneVerificationController {
    const identityScope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<CrewPhoneVerificationStatus | null>(null);
    const [statusScopeToken, setStatusScopeToken] = useState('');
    const [pending, setPending] = useState<CrewPhoneVerificationPending | null>(null);
    const [countryCode, setCountryCodeState] = useState('AU');
    const [localNumber, setLocalNumberState] = useState('');
    const [code, setCodeState] = useState('');
    const [error, setError] = useState('');
    const [starting, setStarting] = useState(false);
    const [checking, setChecking] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [retryAt, setRetryAt] = useState(0);
    const [cooldownSeconds, setCooldownSeconds] = useState(0);
    const operationRef = useRef(0);
    const localNumberRef = useRef('');
    const codeRef = useRef('');

    const clearSensitiveValues = useCallback(() => {
        localNumberRef.current = '';
        codeRef.current = '';
        setLocalNumberState('');
        setCodeState('');
    }, []);

    const loadStatus = useCallback(async (): Promise<void> => {
        const scope = getAuthIdentityScope();
        const scopeToken = `${scope.generation}:${scope.key}`;
        const operation = ++operationRef.current;
        if (!scope.userId) {
            setStatus(null);
            setStatusScopeToken(scopeToken);
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        try {
            const nextStatus = await CrewPhoneVerificationService.getStatus();
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            setStatus(nextStatus);
            setStatusScopeToken(scopeToken);
        } catch (loadError) {
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            setStatus(null);
            setStatusScopeToken(scopeToken);
            setError(publicErrorMessage(loadError));
        } finally {
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) setLoading(false);
        }
    }, []);

    useEffect(() => {
        operationRef.current += 1;
        clearSensitiveValues();
        setCountryCodeState('AU');
        setStatus(null);
        setStatusScopeToken('');
        setPending(null);
        setRetryAt(0);
        setCooldownSeconds(0);
        setError('');
        setStarting(false);
        setChecking(false);
        setRemoving(false);
        void loadStatus();
        return () => {
            operationRef.current += 1;
            localNumberRef.current = '';
            codeRef.current = '';
        };
    }, [clearSensitiveValues, identityScope.generation, identityScope.key, loadStatus]);

    useEffect(() => {
        if (retryAt <= Date.now()) {
            setCooldownSeconds(0);
            return;
        }
        const update = () => setCooldownSeconds(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
        update();
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [retryAt]);

    const setCountryCode = useCallback((nextCountryCode: string) => {
        setCountryCodeState(nextCountryCode.trim().toUpperCase().slice(0, 2));
        setError('');
    }, []);

    const setLocalNumber = useCallback((nextPhone: string) => {
        const normalized = nextPhone.replace(/[^0-9()+\-\s]/g, '').slice(0, 24);
        localNumberRef.current = normalized;
        setLocalNumberState(normalized);
        setError('');
    }, []);

    const setCode = useCallback((nextCode: string) => {
        const normalized = nextCode.replace(/\D/g, '').slice(0, 6);
        codeRef.current = normalized;
        setCodeState(normalized);
        setError('');
    }, []);

    const start = useCallback(async (): Promise<void> => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || starting || checking || removing) return;
        const operation = ++operationRef.current;
        setStarting(true);
        setError('');
        try {
            const result = await CrewPhoneVerificationService.start(localNumberRef.current, countryCode);
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            codeRef.current = '';
            setCodeState('');
            setPending(result);
            const nextRetryAt = Date.now() + result.retryAfterSeconds * 1000;
            setRetryAt(nextRetryAt);
            setCooldownSeconds(result.retryAfterSeconds);
        } catch (startError) {
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            const waitSeconds = retrySeconds(startError);
            if (waitSeconds !== undefined) {
                setRetryAt(Date.now() + waitSeconds * 1000);
                setCooldownSeconds(waitSeconds);
            }
            setError(publicErrorMessage(startError));
        } finally {
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) setStarting(false);
        }
    }, [checking, countryCode, removing, starting]);

    const check = useCallback(async (): Promise<void> => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || checking || removing || starting) return;
        const operation = ++operationRef.current;
        setChecking(true);
        setError('');
        try {
            const result = await CrewPhoneVerificationService.check(codeRef.current);
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            const nextStatus: CrewPhoneVerificationStatus = {
                verified: true,
                last4: result.last4,
                verifiedAt: result.verifiedAt,
                // The server accepts an SMS check only for an account whose
                // email is already confirmed, so this successful response is
                // also authoritative for the email half of the publish gate.
                emailVerified: true,
            };
            setStatus(nextStatus);
            setStatusScopeToken(`${scope.generation}:${scope.key}`);
            setPending(null);
            setRetryAt(0);
            setCooldownSeconds(0);
            clearSensitiveValues();
        } catch (checkError) {
            if (operation !== operationRef.current || !isAuthIdentityScopeCurrent(scope)) return;
            const waitSeconds = retrySeconds(checkError);
            if (waitSeconds !== undefined) {
                setRetryAt(Date.now() + waitSeconds * 1000);
                setCooldownSeconds(waitSeconds);
            }
            setError(publicErrorMessage(checkError));
        } finally {
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) setChecking(false);
        }
    }, [checking, clearSensitiveValues, removing, starting]);

    const resend = useCallback(async (): Promise<void> => {
        if (cooldownSeconds > 0) return;
        await start();
    }, [cooldownSeconds, start]);

    const changeNumber = useCallback(() => {
        operationRef.current += 1;
        setPending(null);
        setRetryAt(0);
        setCooldownSeconds(0);
        setError('');
        setStarting(false);
        setChecking(false);
        setRemoving(false);
        clearSensitiveValues();
    }, [clearSensitiveValues]);

    const remove = useCallback(async (): Promise<void> => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || removing || starting || checking) return;
        const operation = ++operationRef.current;
        let shouldRefresh = false;
        setRemoving(true);
        setError('');
        try {
            const removed = await CrewPhoneVerificationService.remove();
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) {
                if (!removed) {
                    setError('Could not change your verified mobile. Please try again.');
                } else {
                    clearSensitiveValues();
                    setPending(null);
                    setRetryAt(0);
                    setCooldownSeconds(0);
                    setStatus(null);
                    shouldRefresh = true;
                }
            }
        } catch (removeError) {
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) {
                setError(publicErrorMessage(removeError));
            }
        } finally {
            if (operation === operationRef.current && isAuthIdentityScopeCurrent(scope)) setRemoving(false);
        }
        if (shouldRefresh && isAuthIdentityScopeCurrent(scope)) await loadStatus();
    }, [checking, clearSensitiveValues, loadStatus, removing, starting]);

    const activeScopeToken = `${identityScope.generation}:${identityScope.key}`;
    const statusIsCurrent = statusScopeToken === activeScopeToken;
    const publicationState: CrewPhoneVerificationController['publicationState'] = !identityScope.userId
        ? 'blocked'
        : !statusIsCurrent || loading
          ? 'checking'
          : status?.verified === true && status.emailVerified === true
            ? 'ready'
            : status === null && !!error
              ? 'unavailable'
              : 'blocked';

    return {
        signedIn: !!identityScope.userId,
        loading,
        status,
        pending,
        publicationState,
        publicationReady: publicationState === 'ready',
        countryCode,
        localNumber,
        code,
        error,
        starting,
        checking,
        removing,
        cooldownSeconds,
        setCountryCode,
        setLocalNumber,
        setCode,
        start,
        check,
        resend,
        changeNumber,
        remove,
        refresh: loadStatus,
    };
}
