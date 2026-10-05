import './style.css';
import { ResearchAuthController, type ResearchAuthState } from './auth';
import { createResearchMessagingController, renderResearchMessages, researchSendSetupReady } from './messaging';

function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error('Research interface unavailable');
    return found as T;
}

const auth = new ResearchAuthController();
const messaging = createResearchMessagingController(auth);
messaging.setVisible(document.visibilityState !== 'hidden');
const form = element<HTMLFormElement>('sign-in-form');
const email = element<HTMLInputElement>('email');
const password = element<HTMLInputElement>('password');
const signIn = element<HTMLButtonElement>('sign-in');
const reverify = element<HTMLButtonElement>('reverify');
const reverifyPairing = element<HTMLButtonElement>('reverify-pairing');
const signOut = element<HTMLButtonElement>('sign-out');

const messages: Record<ResearchAuthState['status'], { title: string; detail: string }> = {
    unsupported: {
        title: 'Native research app required',
        detail: 'This screen can verify accounts only in the separate iPhone or iPad research app.',
    },
    unavailable: {
        title: 'Account access unavailable',
        detail: 'No account authority is shown. Reverify or sign in if controls are available; otherwise reopen the research app after its setup is checked.',
    },
    signed_out: {
        title: 'Login required',
        detail: 'Sign in with the same account to continue a saved research session. Explicit Log out closes that session and quarantines its history.',
    },
    verifying: {
        title: 'Verifying native account state…',
        detail: 'Account authority and message plaintext are hidden while the native session changes.',
    },
    authenticated: {
        title: 'Account verified by native Auth',
        detail: 'Account access only—not permission to send. Use the explicit native setup and message controls below.',
    },
};

auth.subscribe((state) => {
    // Fixed local-stage wording only. Never show SDK/native errors, credentials
    // or infer a specific expiry cause from an unavailable native account.
    const reason = auth.getUnavailableReason();
    const message =
        state.status === 'unavailable' && reason === 'verification_lost'
            ? {
                  title: 'Account verification needs renewing',
                  detail: 'The previously verified account is no longer current. Tap Reverify account to check it again; no password is needed if this app still holds your sign-in.',
              }
            : state.status === 'unavailable' && reason === 'credentials_rejected'
              ? {
                    title: 'Research sign-in rejected',
                    detail: 'Check your research account email and password. These test credentials are separate from normal Thalassa.',
                }
              : state.status === 'unavailable' && reason === 'verification_failed'
                ? {
                      title: 'Account verification did not complete',
                      detail: 'This does not prove your password was rejected. Reverify if a sign-in is held; otherwise sign in again. Messaging stays locked until native verification succeeds.',
                  }
                : messages[state.status];
    element('auth-status').textContent = message.title;
    element('auth-status').dataset.state = state.status;
    element('auth-detail').textContent = message.detail;
    element('account-id').textContent = state.account?.accountId ?? 'Unavailable';
    element('device-id').textContent = state.account?.deviceId ?? 'Unavailable';
    element('verification').textContent = state.account ? 'Server-verified account · research only' : 'Not verified';
    const disabled = !auth.canSignIn() || state.status === 'unsupported' || state.status === 'verifying';
    signIn.disabled = disabled;
    email.disabled = disabled;
    password.disabled = disabled;
    reverify.disabled = disabled || state.status === 'signed_out';
    reverifyPairing.disabled = reverify.disabled;
    element('pairing-auth-status').textContent =
        state.status === 'authenticated'
            ? 'Account verified. Research checks are short-lived; public cards stay through renewal, but trust must be inspected and compared again.'
            : state.status === 'verifying'
              ? 'Checking your native account. Setup stays locked until verification completes.'
              : state.status === 'unavailable' && reason === 'verification_lost'
                ? 'Account check needs renewing. Setup actions can renew the same account; do not log out. Inspect and compare again before confirming.'
                : 'Sign in and verify above to unlock setup. Reverify here if your sign-in is still held.';
    signOut.disabled = !auth.canSignOut() || state.status === 'unsupported';
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    const enteredPassword = password.value;
    password.value = '';
    void auth.signIn(email.value, enteredPassword);
});
reverify.addEventListener('click', () => void auth.reverify());
// The same explicit verification only: never enroll, claim, send or retry as a
// side effect of re-opening controls. All messaging guards remain unchanged.
reverifyPairing.addEventListener('click', () => void auth.reverify());
signOut.addEventListener('click', () => {
    password.value = '';
    void auth.signOut();
});

const draft = element<HTMLTextAreaElement>('message-draft');
const peerInput = element<HTMLTextAreaElement>('peer-card');
const ownCard = element<HTMLTextAreaElement>('own-card');
const compared = element<HTMLInputElement>('compared-peer');
const messageForm = element<HTMLFormElement>('message-form');
const actionIds = [
    'read-state',
    'register-device',
    'own-card-button',
    'inspect-peer',
    'confirm-peer',
    'claim-peer',
    'refresh-policy',
    'read-thread',
    'receive',
    'retry-pending',
    'prepare-only',
    'send-message',
] as const;
const buttons = Object.fromEntries(actionIds.map((id) => [id, element<HTMLButtonElement>(id)])) as Record<
    (typeof actionIds)[number],
    HTMLButtonElement
>;
const copyCard = element<HTMLButtonElement>('copy-card');

messaging.subscribe((state) => {
    const disabled = !state.available || state.busy;
    const pairingDisabled = !state.pairingAvailable || state.busy;
    const publicCardsDisabled = !state.publicCardsAvailable || state.busy;
    for (const button of Object.values(buttons)) button.disabled = disabled;
    for (const id of ['read-state', 'register-device', 'own-card-button', 'inspect-peer'] as const)
        buttons[id].disabled = pairingDisabled;
    element('message-status').textContent = state.notice;
    element('message-status').setAttribute('aria-busy', String(state.busy));
    element('pairing-action-status').textContent = state.notice;
    element('pairing-action-status').setAttribute('aria-busy', String(state.busy));
    element('pairing-facts').textContent = state.facts
        ? `Pairing: ${state.facts.pairing} · Role: ${state.facts.role}\nRegistration: ${state.facts.registration} · Claim: ${state.facts.claim}`
        : 'Setup facts unknown. Tap Read setup facts; no setup runs automatically.';
    element('role-detail').textContent =
        state.facts?.role === 'responder'
            ? 'Native role: responder. Do not claim or send first. Receive the initiator’s first message, then reply.'
            : state.facts?.role === 'initiator'
              ? 'Native role: initiator. Explicitly claim the registered peer before the first message.'
              : 'The native role determines who starts; JavaScript does not choose a device or session.';
    element('policy-facts').textContent = state.policy
        ? `At last check — owner revoked: ${state.policy.ownerRevoked}; peer revoked: ${state.policy.peerRevoked}; blocked by you: ${state.policy.blockedByMe}; blocked by peer: ${state.policy.blockedByPeer}. Not a durable send permission.`
        : 'Relay policy unknown or expired. Send and Receive request a fresh native check.';
    if (draft.value !== state.draft) draft.value = state.draft;
    if (peerInput.value !== state.peerCardInput) peerInput.value = state.peerCardInput;
    ownCard.value = state.ownCard?.card ?? '';
    element('own-fingerprint').textContent = state.ownCard?.fingerprint ?? 'Not exported';
    element('peer-fingerprint').textContent = state.inspectedPeer?.fingerprint ?? 'Inspect a public peer card first';
    compared.checked = state.comparedOnOtherDevice;
    compared.disabled = disabled || !state.inspectedPeer || !!state.attempt;
    draft.disabled = disabled || !!state.attempt;
    peerInput.disabled = publicCardsDisabled || !!state.attempt;
    copyCard.disabled = publicCardsDisabled || !state.ownCard;
    buttons['inspect-peer'].disabled = pairingDisabled || !!state.attempt || !state.peerCardInput.trim();
    buttons['confirm-peer'].disabled =
        disabled || !!state.attempt || !state.inspectedPeer || !state.comparedOnOtherDevice;
    buttons['claim-peer'].disabled = disabled || state.facts?.role !== 'initiator';
    const sendDisabled = disabled || !!state.attempt || !state.draft.trim() || !researchSendSetupReady(state.facts);
    buttons['send-message'].disabled = sendDisabled;
    buttons['prepare-only'].disabled = sendDisabled;
    buttons['retry-pending'].disabled = disabled || !state.attempt;
    element('pending-attempt').textContent = state.attempt
        ? `Unresolved attempt ${state.attempt.clientMessageId}. New sends are disabled. Retry reconciles native history and reuses only this durable ID; it never prepares replacement ciphertext.`
        : '';
    element('capacity').textContent = state.thread
        ? `Native history limits: ${state.thread.outgoingCapacity} outgoing / ${state.thread.incomingCapacity} incoming · unresolved: ${state.thread.unresolvedCount}`
        : 'Native research history is bounded: 16 outgoing / 16 incoming.';
    element('inbox-report').textContent = state.inboxReport
        ? `Last native scan: stored ${state.inboxReport.stored}, duplicates ${state.inboxReport.duplicates}, historical ${state.inboxReport.historical}, unresolved ${state.inboxReport.unresolved}, historical unresolved ${state.inboxReport.historicalUnresolved}.`
        : '';
    element('copy-status').textContent = '';
    renderResearchMessages(element('message-list'), state.thread?.messages ?? []);
    element('thread-empty').hidden = (state.thread?.messages.length ?? 0) !== 0;
});

draft.addEventListener('input', () => {
    messaging.setDraft(draft.value);
    draft.value = messaging.getState().draft;
});
peerInput.addEventListener('input', () => {
    messaging.setPeerCardInput(peerInput.value);
    peerInput.value = messaging.getState().peerCardInput;
});
compared.addEventListener('change', () => messaging.setComparedOnOtherDevice(compared.checked));
buttons['read-state'].addEventListener('click', () => void messaging.readState());
buttons['register-device'].addEventListener('click', () => void messaging.registerDevice());
buttons['own-card-button'].addEventListener('click', () => void messaging.ownPairingCard());
buttons['inspect-peer'].addEventListener('click', () => void messaging.inspectPeerCard());
buttons['confirm-peer'].addEventListener('click', () => void messaging.confirmPeer());
buttons['claim-peer'].addEventListener('click', () => void messaging.claimPeer());
buttons['refresh-policy'].addEventListener('click', () => void messaging.refreshPolicy());
buttons['read-thread'].addEventListener('click', () => void messaging.readThread());
buttons.receive.addEventListener('click', () => void messaging.receive());
buttons['retry-pending'].addEventListener('click', () => void messaging.retryPending());
buttons['prepare-only'].addEventListener('click', () => void messaging.prepareOnly());
messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void messaging.sendText();
});
copyCard.addEventListener('click', async () => {
    // Capture public data only, not a state object retaining message plaintext.
    const { publicCardsAvailable, busy, ownCard: publicCard, revision } = messaging.getState();
    if (!publicCardsAvailable || busy || !publicCard) return;
    try {
        await navigator.clipboard.writeText(publicCard.card);
        if (messaging.getState().revision === revision && messaging.getState().publicCardsAvailable)
            element('copy-status').textContent =
                'Public card copied. Your operating system manages clipboard retention.';
    } catch {
        if (messaging.getState().revision === revision && messaging.getState().publicCardsAvailable)
            element('copy-status').textContent =
                'Copy unavailable. Select the public card and use the system copy action.';
    }
});

// Native lease expiry must not leave a stale authenticated display. These
// checks read native state only; they do not fetch or silently reverify tokens.
const leaseCheck = window.setInterval(() => void auth.checkCurrentAccount(), 15_000);
document.addEventListener('visibilitychange', () => {
    messaging.setVisible(document.visibilityState !== 'hidden');
    if (document.visibilityState === 'hidden') password.value = '';
    else void auth.checkCurrentAccount();
});
window.addEventListener('pagehide', () => {
    password.value = '';
    window.clearInterval(leaseCheck);
    messaging.dispose();
    auth.dispose();
});

void auth.initialize().then(() => {
    const state = auth.getState();
    signIn.disabled = !auth.canSignIn() || state.status === 'verifying';
    email.disabled = signIn.disabled;
    password.disabled = signIn.disabled;
    signOut.disabled = !auth.canSignOut();
});
