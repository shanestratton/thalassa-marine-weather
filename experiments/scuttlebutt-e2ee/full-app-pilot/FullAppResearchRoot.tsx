/** Actual App/providers/router under closed build boundaries. App remains in
 * browse mode: native Research metadata is not a fabricated Supabase User. */
import React from 'react';
import App from '../../../App';
import { ThalassaProvider } from '../../../context/ThalassaContext';
import { CrewCountProvider } from '../../../contexts/CrewCountContext';
import { normalizeAppPrivateMessageSelection } from '../../../services/chat/e2ee/appPrivateMessageSelection';
import { PrivateMessageResearchApp } from '../app-pilot/PrivateMessageResearchApp';
import type { PrivateMessageResearchRuntime } from '../app-pilot/runtime';
import type { ChatPageProps } from '../../../components/ChatPage';
import { attachFullAppResearchAuth } from './authProjection';

function observeRuntime(owned: PrivateMessageResearchRuntime): () => void {
    const attachment = attachFullAppResearchAuth(owned.auth);
    let stopped = false;
    const hide = () => attachment.deactivate();
    const visibility = () => {
        if (document.visibilityState === 'hidden') hide();
        else if (!stopped) attachment.reactivate();
    };
    const pagehide = (event: PageTransitionEvent) => {
        hide();
        if (!event.persisted) stopped = true;
    };
    const pageshow = (event: PageTransitionEvent) => {
        if (event.persisted && !stopped && document.visibilityState !== 'hidden') attachment.reactivate();
    };
    if (document.visibilityState === 'hidden') hide();
    // These presentation listeners never sign in, reverify or access native.
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    return () => {
        stopped = true;
        attachment.detach();
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('pagehide', pagehide);
        window.removeEventListener('pageshow', pageshow);
    };
}
function renderApp({ selection }: Pick<ChatPageProps, 'selection' | 'onBack'>) {
    // Normalize on EVERY mount/render. Missing, invalid or legacy selection
    // never asks App to adopt its ordinary absent-prop default.
    const closed = normalizeAppPrivateMessageSelection(selection);
    return (
        <ThalassaProvider>
            <CrewCountProvider>
                <App privateMessageSelection={closed} />
            </CrewCountProvider>
        </ThalassaProvider>
    );
}
export function FullAppResearchRoot({ createRuntime }: { createRuntime: () => PrivateMessageResearchRuntime }) {
    return (
        <PrivateMessageResearchApp
            createRuntime={createRuntime}
            onRuntime={observeRuntime}
            renderPrivatePage={renderApp}
        />
    );
}
