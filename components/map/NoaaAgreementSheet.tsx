import React, { useEffect, useRef, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    acceptNoaaAgreement,
    loadNoaaAgreementText,
    NOAA_AGREEMENT_URL,
    NOAA_ENC_ORIGIN,
} from '../../services/enc/noaaAgreement';

interface Props {
    onClose: () => void;
    onAccepted: () => void;
}
export default function NoaaAgreementSheet({ onClose, onAccepted }: Props) {
    const scope = useRef(getAuthIdentityScope()).current;
    const [text, setText] = useState<string | null>(null);
    const [checked, setChecked] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const alive = useRef(true);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        const unsubscribe = subscribeAuthIdentityScope(() => {
            controller.abort();
            setText(null);
            setChecked(false);
            close.current();
        });
        void loadNoaaAgreementText(controller.signal)
            .then((value) => {
                if (alive.current && isAuthIdentityScopeCurrent(scope)) setText(value);
            })
            .catch(() => {
                if (alive.current && isAuthIdentityScopeCurrent(scope))
                    setError('The NOAA agreement could not be opened. Reconnect or update the app and try again.');
            });
        return () => {
            alive.current = false;
            controller.abort();
            unsubscribe();
        };
    }, [scope]);
    const accept = async () => {
        if (!text || !checked || saving || !isAuthIdentityScopeCurrent(scope)) return;
        setSaving(true);
        setError(null);
        try {
            const saved = await acceptNoaaAgreement(text, scope);
            if (!alive.current || !isAuthIdentityScopeCurrent(scope)) return;
            if (!saved) throw Error('Consent not saved');
            onAccepted();
        } catch {
            if (alive.current && isAuthIdentityScopeCurrent(scope))
                setError('Acceptance could not be saved. No NOAA download has started.');
        } finally {
            if (alive.current && isAuthIdentityScopeCurrent(scope)) setSaving(false);
        }
    };
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title="NOAA chart agreement"
            zIndex="z-10070"
            footer={
                <div className="space-y-3">
                    <label className="flex items-start gap-3 text-sm text-slate-200">
                        <input
                            type="checkbox"
                            checked={checked}
                            disabled={!text || saving}
                            onChange={(event) => setChecked(event.target.checked)}
                            className="mt-1 h-5 w-5 shrink-0"
                        />
                        I have read and accept the NOAA ENC User Agreement above.
                    </label>
                    <button
                        type="button"
                        onClick={() => void accept()}
                        disabled={!text || !checked || saving}
                        className="min-h-11 w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40"
                    >
                        {saving ? 'Saving…' : 'Accept NOAA agreement'}
                    </button>
                </div>
            }
        >
            <p className="mb-3 text-sm text-slate-300">
                NOAA is the source of these chart data. Thalassa and its derived or redistributed charts are not
                certified NOAA ENC products or an approved ECDIS, and do not satisfy regulated chart carriage
                requirements.
            </p>
            <p className="mb-4 text-sm text-slate-300">
                You are responsible for current editions and weekly updates.{' '}
                <a href={NOAA_ENC_ORIGIN} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
                    NOAA source
                </a>{' '}
                ·{' '}
                <a
                    href={NOAA_AGREEMENT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-300 underline"
                >
                    Original agreement
                </a>
            </p>
            {error && (
                <p role="alert" className="mb-3 text-sm text-amber-300">
                    {error}
                </p>
            )}
            {text ? (
                <pre
                    aria-label="NOAA ENC User Agreement"
                    className="whitespace-pre-wrap break-words rounded-xl bg-slate-950/60 p-3 font-sans text-sm leading-relaxed text-slate-200"
                >
                    {text}
                </pre>
            ) : (
                !error && (
                    <p role="status" className="text-sm text-slate-400">
                        Opening the NOAA terms…
                    </p>
                )
            )}
        </ModalSheet>
    );
}
