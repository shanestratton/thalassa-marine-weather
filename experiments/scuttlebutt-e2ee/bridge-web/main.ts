import './style.css';
import { ResearchAuthController, type ResearchAuthState } from './auth';

function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error('Research interface unavailable');
    return found as T;
}

const auth = new ResearchAuthController();
const form = element<HTMLFormElement>('sign-in-form');
const email = element<HTMLInputElement>('email');
const password = element<HTMLInputElement>('password');
const signIn = element<HTMLButtonElement>('sign-in');
const reverify = element<HTMLButtonElement>('reverify');
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
        title: 'Signed out',
        detail: 'The previous native owner is closed. Sign in to verify this research account. Messaging remains disconnected.',
    },
    verifying: {
        title: 'Verifying native account state…',
        detail: 'Account authority is hidden while the native session changes. Messaging remains disconnected.',
    },
    authenticated: {
        title: 'Account verified by native Auth',
        detail: 'Account access only; messaging remains disconnected. Log out before changing research accounts.',
    },
};

let started = false;
auth.subscribe((state) => {
    element('auth-status').textContent = messages[state.status].title;
    element('auth-status').dataset.state = state.status;
    element('auth-detail').textContent = messages[state.status].detail;
    element('account-id').textContent = state.account?.accountId ?? 'Unavailable';
    element('device-id').textContent = state.account?.deviceId ?? 'Unavailable';
    element('verification').textContent = state.account ? 'Server-verified account · research only' : 'Not verified';
    const disabled = !started || state.status === 'unsupported' || state.status === 'verifying';
    signIn.disabled = disabled;
    email.disabled = disabled;
    password.disabled = disabled;
    reverify.disabled = disabled || state.status === 'signed_out';
    signOut.disabled = !started || state.status === 'unsupported';
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    const enteredPassword = password.value;
    password.value = '';
    void auth.signIn(email.value, enteredPassword);
});
reverify.addEventListener('click', () => void auth.reverify());
signOut.addEventListener('click', () => {
    password.value = '';
    void auth.signOut();
});

// Native lease expiry must not leave a stale authenticated display. These
// checks read native state only; they do not fetch or silently reverify tokens.
const leaseCheck = window.setInterval(() => void auth.checkCurrentAccount(), 15_000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') password.value = '';
    else void auth.checkCurrentAccount();
});
window.addEventListener('pagehide', () => {
    password.value = '';
    window.clearInterval(leaseCheck);
    auth.dispose();
});

void auth.initialize().then(() => {
    started = auth.getState().status !== 'unsupported' && auth.getState().status !== 'unavailable';
    const state = auth.getState();
    signIn.disabled = !started || state.status === 'verifying';
    email.disabled = signIn.disabled;
    password.disabled = signIn.disabled;
    signOut.disabled = !started;
});
