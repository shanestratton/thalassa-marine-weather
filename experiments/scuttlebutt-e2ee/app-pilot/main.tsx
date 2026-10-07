/** Real Thalassa PM page composed with the SAME isolated Research Auth host.
 * No production SDK, second verification loop, enrollment, policy mutation,
 * private legacy load, queue, push or hidden send. Not the full Thalassa shell.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPage, type ChatPageSelection } from '../../../components/ChatPage';
import { setAuthIdentityScope } from '../../../services/authIdentityScope';
import { createPrivateMessagePilotRuntime } from '../../../services/chat/e2ee/privateMessagePilot';
import { createNativePrivateMessageStartup } from '../../../services/chat/e2ee/privateMessageStartup';
import { ResearchAuthController, researchNativePlugin } from '../bridge-web/auth';
import { createResearchPrivateMessageNativePlugin } from '../bridge-web/privateMessagePort';
import { createResearchPrivateAdmissionSource } from '../bridge-web/privateAdmissionSource';
import './style.css';

const auth = new ResearchAuthController();
const admissionSource = createResearchPrivateAdmissionSource(researchNativePlugin);
const admission = createNativePrivateMessageStartup({ native: admissionSource });
const port = createResearchPrivateMessageNativePlugin(researchNativePlugin);
const runtime = createPrivateMessagePilotRuntime(port);
const currentlyVisible = () => document.visibilityState !== 'hidden';
function App() {
    const viewRevision = useRef(0);
    const [authState, setAuthState] = useState(auth.getState());
    const [admissionState, setAdmissionState] = useState(admission.state());
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [selection, setSelection] = useState<ChatPageSelection>({ kind: 'native-unavailable' });
    const [busy, setBusy] = useState(false);
    const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
    useEffect(() => {
        const clear = () => {
            viewRevision.current += 1;
            admissionSource.invalidate();
            port.invalidateView();
            setSelection({ kind: 'native-unavailable' });
        };
        const stopAuth = auth.subscribe((state) => {
            clear();
            setAuthState(state);
            // This projection comes from the controller's fresh NATIVE /user
            // result, never a token payload, browser marker or caller user ID.
            setAuthIdentityScope(state.status === 'authenticated' ? (state.account?.accountId ?? null) : null);
        });
        const stopAdmission = admission.subscribeState(setAdmissionState);
        const visibility = () => {
            clear();
            setPassword('');
            setVisible(document.visibilityState !== 'hidden');
            if (document.visibilityState !== 'hidden') void auth.checkCurrentAccount();
        };
        const timer = window.setInterval(() => {
            if (document.visibilityState !== 'hidden') void auth.checkCurrentAccount();
        }, 5000);
        const pagehide = () => {
            clear();
            setPassword('');
            admission.stop();
            auth.dispose();
        };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', pagehide);
        void auth.initialize();
        return () => {
            clear();
            admission.stop();
            stopAuth();
            stopAdmission();
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', pagehide);
            // No implicit durable native logout on unmount/window hiding.
        };
    }, []);
    const close = () => {
        viewRevision.current += 1;
        admissionSource.invalidate();
        port.invalidateView();
        setSelection({ kind: 'native-unavailable' });
    };
    const reverify = async () => {
        close();
        setBusy(true);
        try {
            await auth.reverify();
        } finally {
            setBusy(false);
        }
    };
    const open = async () => {
        close();
        setBusy(true);
        const ticket = viewRevision.current;
        try {
            const before = auth.getState().account;
            if (!visible || !currentlyVisible() || auth.getState().status !== 'authenticated' || !before) return;
            await admission.refresh();
            if (ticket !== viewRevision.current || admission.state().kind !== 'protected-required') return;
            const ready = await port.connectCurrentAccount(before.credentialBinding);
            const after = auth.getState();
            if (
                ticket !== viewRevision.current ||
                !currentlyVisible() ||
                after.status !== 'authenticated' ||
                after.account?.credentialBinding !== before.credentialBinding ||
                ready.status !== 'ready' ||
                ready.authority.accountId !== before.accountId ||
                ready.authority.deviceId !== before.deviceId
            )
                return;
            setSelection({ kind: 'native-pilot', runtime });
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <header>
                <p>THALASSA RESEARCH</p>
                <h1>Private messages</h1>
                <p>Encryption test—not reviewed</p>
            </header>
            <section className="card" aria-label="Research account access">
                <p role="status">
                    Account: {authState.status} · Local private admission: {admissionState.kind}
                </p>
                <p>No legacy fallback. Start-up facts are not encryption, peer verification or send permission.</p>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        close();
                        const value = password;
                        setPassword('');
                        setBusy(true);
                        void auth.signIn(email, value).finally(() => setBusy(false));
                    }}
                >
                    <label htmlFor="pilot-email">Test account email</label>
                    <input
                        id="pilot-email"
                        type="email"
                        autoComplete="username"
                        autoCapitalize="none"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        maxLength={320}
                        required
                    />
                    <label htmlFor="pilot-password">Password</label>
                    <input
                        id="pilot-password"
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        maxLength={1024}
                        required
                    />
                    <button disabled={busy || !visible || !auth.canSignIn()} type="submit">
                        Sign in and verify
                    </button>
                </form>
                <div className="actions">
                    <button disabled={busy || !visible || !auth.canSignIn()} onClick={() => void reverify()}>
                        Reverify
                    </button>
                    <button
                        disabled={busy || !visible || !auth.canSignOut()}
                        onClick={() => {
                            close();
                            setPassword('');
                            void auth.signOut();
                        }}
                    >
                        Explicit logout
                    </button>
                </div>
                <p>
                    This test requires an already registered, paired and protected account. No setup runs automatically.
                </p>
                <button disabled={busy || !visible || authState.status !== 'authenticated'} onClick={() => void open()}>
                    Check native setup and open messages
                </button>
            </section>
            <section className="message-panel" aria-label="Thalassa private-message test">
                <ChatPage selection={selection} onBack={close} />
            </section>
        </>
    );
}
const element = document.getElementById('root');
if (!element) throw new Error('Private message research interface unavailable');
createRoot(element).render(<App />);
