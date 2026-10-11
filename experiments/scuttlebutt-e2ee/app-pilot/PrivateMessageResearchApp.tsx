/** The real Thalassa PM page in an isolated, action-fenced Research window.
 * Background/BFCache suspension does not log out or recreate native identity.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatPage, type ChatPageSelection, type ChatPageProps } from '../../../components/ChatPage';
import { setAuthIdentityScope } from '../../../services/authIdentityScope';
import { createPrivateMessageResearchRuntime, type PrivateMessageResearchRuntime } from './runtime';
import {
    measureResearchClosedPresentation,
    type ResearchNativeLifecycleDescriptor,
} from '../bridge-web/nativeLifecycle';

const visibleNow = () => document.visibilityState !== 'hidden';
export function PrivateMessageResearchApp({
    createRuntime = createPrivateMessageResearchRuntime,
    onRuntime,
    renderPrivatePage,
}: {
    createRuntime?: () => PrivateMessageResearchRuntime;
    /** Trusted isolated root only; observes the same effect-owned composition. */
    onRuntime?: (owned: PrivateMessageResearchRuntime) => () => void;
    /** Always receives the closed/native selection, never a legacy default. */
    renderPrivatePage?: (props: Pick<ChatPageProps, 'selection' | 'onBack'>) => React.ReactNode;
}) {
    const resources = useRef<PrivateMessageResearchRuntime | null>(null);
    const mounted = useRef(false);
    const live = useRef(true);
    const viewRevision = useRef(0);
    const actionCounter = useRef(0);
    const action = useRef<number | null>(null);
    const logoutAction = useRef(false);
    const presentationRoot = useRef<HTMLDivElement | null>(null);
    const ackAttempt = useRef<{
        auth: PrivateMessageResearchRuntime['auth'];
        epoch: string;
        count: number;
        progress: number;
        inFlight: boolean;
    } | null>(null);
    const progressRef = useRef(0);
    const presentationObserver = useRef<MutationObserver | null>(null);
    const [presentationProgress, setPresentationProgress] = useState(0);
    const [ackReview, setAckReview] = useState(0);
    const [nativeLifecycle, setNativeLifecycle] = useState<ResearchNativeLifecycleDescriptor | null>(null);
    const [authState, setAuthState] = useState<ReturnType<PrivateMessageResearchRuntime['auth']['getState']>>({
        status: 'signed_out',
        account: null,
    });
    const [admissionState, setAdmissionState] = useState<
        ReturnType<PrivateMessageResearchRuntime['admission']['state']>
    >({ kind: 'unknown' });
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [selection, setSelection] = useState<ChatPageSelection>({ kind: 'native-unavailable' });
    const [busy, setBusy] = useState(false);
    const [visible, setVisible] = useState(visibleNow());
    const [stopped, setStopped] = useState(false);

    const closeView = () => {
        viewRevision.current += 1;
        resources.current?.source.invalidate();
        resources.current?.port.invalidateView();
        if (mounted.current) setSelection({ kind: 'native-unavailable' });
    };
    const cancelAction = () => {
        action.current = null;
        logoutAction.current = false;
        actionCounter.current += 1;
        if (mounted.current) setBusy(false);
    };
    const begin = (logout = false) => {
        if (
            !mounted.current ||
            !live.current ||
            !visibleNow() ||
            (action.current !== null && (!logout || logoutAction.current))
        )
            return null;
        closeView();
        const ticket = ++actionCounter.current;
        action.current = ticket;
        logoutAction.current = logout;
        setBusy(true);
        return ticket;
    };
    const finish = (ticket: number) => {
        if (mounted.current && live.current && action.current === ticket) {
            action.current = null;
            logoutAction.current = false;
            setBusy(false);
        }
    };
    const fresh = (ticket: number, revision: number) =>
        mounted.current &&
        live.current &&
        visibleNow() &&
        action.current === ticket &&
        viewRevision.current === revision;
    useEffect(() => {
        const owned = createRuntime();
        resources.current = owned;
        mounted.current = true;
        live.current = true;
        setStopped(false);
        setVisible(visibleNow());
        const { auth, admission } = owned;
        const stopAuth = auth.subscribe((state) => {
            closeView();
            if (!mounted.current || !live.current) return;
            setAuthState(state);
            // Identity derives from this controller's fresh NATIVE result only.
            setAuthIdentityScope(state.status === 'authenticated' ? (state.account?.accountId ?? null) : null);
        });
        const stopAdmission = admission.subscribeState((state) => {
            if (mounted.current && live.current) setAdmissionState(state);
        });
        const stopNativeLifecycle = auth.isNativeLifecycleManaged()
            ? auth.subscribeNativeLifecycle((descriptor) => {
                  if (!mounted.current || !live.current || resources.current !== owned) return;
                  if (descriptor?.phase !== 'active') {
                      closeView();
                      cancelAction();
                      setPassword('');
                  }
                  setNativeLifecycle(descriptor);
              })
            : () => {};
        let stopRuntime: (() => void) | undefined;
        try {
            stopRuntime = onRuntime?.(owned);
        } catch {
            // Failed full-App observation must not start an unobserved Auth loop.
            closeView();
            live.current = false;
            stopAuth();
            stopAdmission();
            stopNativeLifecycle();
            admission.stop();
            auth.dispose();
            resources.current = null;
            setStopped(true);
            return () => {
                mounted.current = false;
            };
        }
        const hide = () => {
            closeView();
            cancelAction();
            setPassword('');
            setVisible(false);
            auth.suspend(); // Verify-fence credentials; never durable logout.
        };
        const visibility = () => {
            if (!visibleNow()) hide();
            else if (live.current) {
                setVisible(true);
                if (auth.isNativeLifecycleManaged()) void auth.refreshNativeLifecycle();
                else void auth.checkCurrentAccount();
            }
        };
        const pagehide = (event: PageTransitionEvent) => {
            hide();
            if (!event.persisted) {
                live.current = false;
                admission.stop();
                auth.dispose();
                setStopped(true);
            }
        };
        const pageshow = (event: PageTransitionEvent) => {
            if (event.persisted && live.current) {
                closeView();
                setVisible(visibleNow());
                if (auth.isNativeLifecycleManaged()) void auth.refreshNativeLifecycle();
                else void auth.checkCurrentAccount();
            }
        };
        const timer = window.setInterval(() => {
            if (live.current && visibleNow()) void auth.checkCurrentAccount();
        }, 5000);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);
        void auth.initialize();
        return () => {
            closeView();
            cancelAction();
            live.current = false;
            mounted.current = false;
            stopAuth();
            stopAdmission();
            stopNativeLifecycle();
            try {
                stopRuntime?.();
            } catch {
                /* Fixed closed view; no raw diagnostics. */
            }
            admission.stop();
            auth.dispose();
            if (resources.current === owned) resources.current = null;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', pagehide);
            window.removeEventListener('pageshow', pageshow);
            // A later mount gets a new composition, never disposed singletons.
        };
    }, [createRuntime, onRuntime]);
    useEffect(() => {
        const root = presentationRoot.current;
        if (!root) return;
        const progress = () => {
            progressRef.current += 1;
            setPresentationProgress(progressRef.current);
        };
        const observer = new MutationObserver((records) => {
            if (records.length > 0) progress();
        });
        presentationObserver.current = observer;
        observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled', 'value'],
        });
        document.addEventListener('readystatechange', progress);
        window.addEventListener('load', progress);
        return () => {
            observer.disconnect();
            presentationObserver.current = null;
            document.removeEventListener('readystatechange', progress);
            window.removeEventListener('load', progress);
        };
    }, []);
    useLayoutEffect(() => {
        const owned = resources.current,
            root = presentationRoot.current;
        if (
            !owned ||
            !root ||
            !mounted.current ||
            !live.current ||
            stopped ||
            nativeLifecycle?.phase !== 'foreground-covered' ||
            document.readyState !== 'complete'
        )
            return;
        const descriptor = owned.auth.getNativeLifecycleState();
        if (descriptor?.epoch !== nativeLifecycle.epoch || descriptor.phase !== 'foreground-covered') return;
        const facts = measureResearchClosedPresentation(root);
        if (!facts) return;
        // Account for this committed DOM before the asynchronous observer runs;
        // its delayed delivery is not a new reason to retry an unchanged ACK.
        if ((presentationObserver.current?.takeRecords().length ?? 0) > 0) progressRef.current += 1;
        const progress = progressRef.current;
        const previous =
            ackAttempt.current?.auth === owned.auth && ackAttempt.current.epoch === descriptor.epoch
                ? ackAttempt.current
                : null;
        if (previous && (previous.inFlight || previous.count >= 2 || progress <= previous.progress)) return;
        const attempt = {
            auth: owned.auth,
            epoch: descriptor.epoch,
            count: (previous?.count ?? 0) + 1,
            progress,
            inFlight: true,
        };
        ackAttempt.current = attempt;
        const revision = viewRevision.current;
        void owned.auth
            .acknowledgeClosedPresentation(descriptor.epoch, facts)
            .then(() => {
                if (
                    !mounted.current ||
                    !live.current ||
                    resources.current !== owned ||
                    viewRevision.current !== revision
                )
                    return;
                // Native validates the same owned WebView/epoch independently.
                // The replay subscription enables explicit verification only.
            })
            .catch(() => {
                /* Missing/stale ACK leaves native presentation covered. */
            })
            .finally(() => {
                if (ackAttempt.current === attempt) {
                    attempt.inFlight = false;
                    const current = owned.auth.getNativeLifecycleState();
                    if (
                        mounted.current &&
                        resources.current === owned &&
                        current?.epoch === attempt.epoch &&
                        current.phase === 'foreground-covered' &&
                        progressRef.current > attempt.progress
                    )
                        setAckReview((value) => value + 1);
                }
            });
    }, [nativeLifecycle, authState, selection, password, busy, visible, stopped, presentationProgress, ackReview]);
    const signIn = () => {
        const auth = resources.current?.auth;
        if (!auth) return;
        if (!auth.canSignIn()) return;
        const ticket = begin();
        if (ticket === null) return;
        const secret = password;
        setPassword('');
        void auth
            .signIn(email, secret)
            .catch(() => {
                if (action.current === ticket) closeView();
            })
            .finally(() => finish(ticket));
    };
    const reverify = () => {
        const auth = resources.current?.auth;
        if (!auth) return;
        if (!auth.canSignIn()) return;
        const ticket = begin();
        if (ticket === null) return;
        void auth
            .reverify()
            .catch(() => {
                if (action.current === ticket) closeView();
            })
            .finally(() => finish(ticket));
    };
    const logout = () => {
        const auth = resources.current?.auth;
        if (!auth) return;
        if (!auth.canSignOut()) return;
        const ticket = begin(true);
        if (ticket === null) return;
        setPassword('');
        void auth
            .signOut()
            .catch(() => {
                if (action.current === ticket) closeView();
            })
            .finally(() => finish(ticket));
    };
    const open = () => {
        const owned = resources.current;
        if (!owned) return;
        const { auth, admission, port, runtime } = owned;
        const before = auth.getState();
        if (before.status !== 'authenticated' || !before.account) return;
        const epoch = auth.getNativeLifecycleState()?.epoch;
        if (auth.isNativeLifecycleManaged() && !auth.canSignIn()) return;
        const ticket = begin();
        if (ticket === null) return;
        const revision = viewRevision.current,
            owner = before.account;
        void (async () => {
            if (auth.isNativeLifecycleManaged()) {
                const descriptor = await auth.refreshNativeLifecycle();
                if (!fresh(ticket, revision) || descriptor?.phase !== 'active' || descriptor.epoch !== epoch) return;
            }
            await admission.refresh();
            if (!fresh(ticket, revision) || admission.state().kind !== 'protected-required') return;
            const ready = await port.connectCurrentAccount(owner.credentialBinding),
                after = auth.getState();
            if (
                !fresh(ticket, revision) ||
                after.status !== 'authenticated' ||
                after.account?.credentialBinding !== owner.credentialBinding ||
                ready.status !== 'ready' ||
                ready.authority.accountId !== owner.accountId ||
                ready.authority.deviceId !== owner.deviceId
            )
                return;
            setSelection({ kind: 'native-pilot', runtime });
        })()
            .catch(() => {
                if (fresh(ticket, revision)) closeView();
            })
            .finally(() => finish(ticket));
    };
    return (
        <div ref={presentationRoot} data-research-private-window>
            <header>
                <p>THALASSA RESEARCH</p>
                <h1>Private messages</h1>
                <p>Encryption test—not reviewed</p>
            </header>
            <section className="card" aria-label="Research account access">
                <p role="status">
                    Account: {authState.status} · Local private admission: {admissionState.kind}
                </p>
                {stopped && (
                    <p role="status">
                        Research window stopped. Reload to start a fresh verification; legacy sending remains blocked.
                    </p>
                )}
                <p>No legacy fallback. Start-up facts are not encryption, peer verification or send permission.</p>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        signIn();
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
                        disabled={!visible || stopped}
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
                        disabled={!visible || stopped}
                    />
                    <button
                        disabled={busy || !visible || stopped || !resources.current?.auth.canSignIn()}
                        type="submit"
                    >
                        Sign in and verify
                    </button>
                </form>
                <div className="actions">
                    <button
                        disabled={busy || !visible || stopped || !resources.current?.auth.canSignIn()}
                        onClick={reverify}
                    >
                        Reverify
                    </button>
                    <button disabled={!visible || stopped || !resources.current?.auth.canSignOut()} onClick={logout}>
                        Explicit logout
                    </button>
                </div>
                <p>
                    This test requires an already registered, paired and protected account. No setup runs automatically.
                </p>
                <button disabled={busy || !visible || stopped || authState.status !== 'authenticated'} onClick={open}>
                    Check native setup and open messages
                </button>
            </section>
            <section className="message-panel" aria-label="Thalassa private-message test">
                {renderPrivatePage ? (
                    renderPrivatePage({ selection, onBack: closeView })
                ) : (
                    <ChatPage selection={selection} onBack={closeView} />
                )}
            </section>
        </div>
    );
}
