import React, { useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
    ACCOUNT_DELETION_CONFIRMATION,
    deleteCurrentAccount,
    type AccountDeletionResult,
} from '../../services/accountDeletion';
import { TrashIcon } from '../Icons';
import { OverlayPortal } from '../ui/OverlayPortal';

interface DeleteAccountDialogProps {
    isOpen: boolean;
    accountLabel?: string | null;
    onClose: () => void;
    onDeleted: (result: AccountDeletionResult) => void;
}

export const DeleteAccountDialog: React.FC<DeleteAccountDialogProps> = ({
    isOpen,
    accountLabel,
    onClose,
    onDeleted,
}) => {
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: inputRef,
        onEscape: busy ? undefined : onClose,
    });

    useEffect(() => {
        if (!isOpen) return;
        setConfirmation('');
        setBusy(false);
        setError(null);
    }, [isOpen]);

    if (!isOpen) return null;

    const confirmed = confirmation === ACCOUNT_DELETION_CONFIRMATION;

    const handleDelete = async () => {
        if (!confirmed || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await deleteCurrentAccount(confirmation);
            onDeleted(result);
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : 'Account deletion failed. Please try again.');
            setBusy(false);
        }
    };

    return (
        <OverlayPortal
            ref={dialogRef}
            className="flex items-center justify-center bg-black/80 p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            aria-describedby="delete-account-description"
        >
            <button
                type="button"
                className="absolute inset-0 cursor-default"
                aria-label="Cancel account deletion"
                onClick={busy ? undefined : onClose}
                disabled={busy}
            />
            <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-red-500/30 bg-slate-950 shadow-2xl">
                <div className="border-b border-red-500/20 bg-red-500/10 p-5 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-300">
                        <TrashIcon className="h-6 w-6" />
                    </div>
                    <h2 id="delete-account-title" className="text-xl font-bold text-white">
                        Permanently delete account?
                    </h2>
                </div>

                <div className="space-y-5 p-5">
                    <div id="delete-account-description" className="space-y-2 text-sm leading-relaxed text-slate-300">
                        <p>
                            This permanently deletes {accountLabel ? <strong>{accountLabel}</strong> : 'your sign-in'},
                            supported private synced records, uploaded media, and account-linked community content.
                            Limited security or legal audit records may be retained only after identifying and free-form
                            details are removed; shared conversation content may be anonymised rather than deleting
                            other people&apos;s records.
                        </p>
                        <p className="font-semibold text-red-300">This cannot be undone.</p>
                    </div>

                    <label className="block text-sm font-semibold text-white" htmlFor="delete-account-confirmation">
                        Type <span className="font-mono text-red-300">{ACCOUNT_DELETION_CONFIRMATION}</span> to confirm
                    </label>
                    <input
                        ref={inputRef}
                        id="delete-account-confirmation"
                        aria-label={`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion`}
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        className="w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 font-mono text-white outline-hidden transition focus:border-red-400 focus:ring-2 focus:ring-red-400/30 disabled:opacity-60"
                    />

                    {error && (
                        <div
                            role="alert"
                            className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
                        >
                            {error}
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={busy}
                            className="rounded-xl bg-slate-800 px-4 py-3 text-sm font-bold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleDelete()}
                            disabled={!confirmed || busy}
                            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {busy ? 'Deleting…' : 'Delete forever'}
                        </button>
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};
