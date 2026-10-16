import { useState, useSyncExternalStore } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { supabase } from '../../services/supabase';
import { satelliteModeActive } from '../../services/networkPolicy';
import { withTimeout } from '../../utils/deadline';
import {
    pendingShoreConsent,
    clearShoreConsent,
    subscribeShoreConsent,
    redactShoreConsent,
    type ShoreConsentLink,
} from '../../services/shoreConsentLink';
/** URL fragments are not sent to HTTP servers. Consume once, remove before any
 * request and never persist/log/retry this bearer. GET never records consent. */
export default function GlobalShoreConsentGate() {
    const link = useSyncExternalStore(subscribeShoreConsent, pendingShoreConsent, pendingShoreConsent);
    const [state, setState] = useState<{ link: ShoreConsentLink; busy: boolean; message: string } | null>(null);
    if (!link) return null;
    const busy = state?.link === link && state.busy,
        message = state?.link === link ? state.message : '';
    const submit = async () => {
        if (!supabase || satelliteModeActive()) {
            setState({ link, busy: false, message: 'Connect to the internet to review this invitation.' });
            return;
        }
        setState({ link, busy: true, message: '' });
        try {
            const r = await withTimeout(
                supabase.functions.invoke('anchor-alert-messaging', { body: { ...link, accepted: true } }),
                null,
                8000,
            );
            if (pendingShoreConsent() !== link) return;
            if (r && !r.error && r.data?.accepted === true) {
                const next = redactShoreConsent(link);
                if (!next) return;
                setState({
                    link: next,
                    busy: false,
                    message:
                        link.action === 'confirm'
                            ? 'Consent recorded. The owner must separately enable delivery.'
                            : 'Consent revoked. Pending work is retired. A message already accepted by a provider may still arrive.',
                });
            } else
                setState({
                    link,
                    busy: false,
                    message: 'Expired, already used or unavailable. Ask the vessel owner for a new invitation.',
                });
        } catch {
            if (pendingShoreConsent() === link)
                setState({
                    link,
                    busy: false,
                    message: 'No confirmation was received. Nothing will be retried automatically.',
                });
        }
    };
    const close = () => {
        clearShoreConsent(link);
    };
    return (
        <ModalSheet
            isOpen
            title={link.action === 'confirm' ? 'Confirm shore-contact invitation' : 'Revoke shore-contact consent'}
            onClose={close}
            zIndex="z-10070"
            footer={
                <button
                    className="min-h-11 px-4 py-2 bg-sky-900 text-white rounded-lg disabled:opacity-40"
                    type="button"
                    onClick={close}
                >
                    Close invitation
                </button>
            }
        >
            <div className="space-y-4 p-4 text-slate-200">
                <p>
                    Review the invitation you received and its position-sharing choice. Confirm only if you want
                    personal anchor-watch messages for that vessel. Delivery can be delayed or unavailable; this service
                    does not monitor your safety or contact rescue services.
                </p>
                <button
                    className="min-h-11 px-4 py-2 bg-sky-900 text-white rounded-lg disabled:opacity-40"
                    type="button"
                    disabled={busy || !link.nonce}
                    onClick={() => void submit()}
                >
                    {link.action === 'confirm' ? 'I consent to the invitation' : 'Revoke my consent'}
                </button>
                {message && <p role="status">{message}</p>}
            </div>
        </ModalSheet>
    );
}
