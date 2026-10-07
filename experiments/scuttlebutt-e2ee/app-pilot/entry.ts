// Dedicated research entry. The ordinary index.tsx never imports this module.
// Deny BEFORE loading SDK/UI consumers, including anonymous/provisional boot.
import { requireNativePrivateMessagesForProcess } from '../../../services/chat/e2ee/privateMessageCutover';
requireNativePrivateMessagesForProcess();
void import('./main').catch(() => {
    const target = document.getElementById('root');
    if (target) target.textContent = 'Private message research unavailable. Legacy sending remains blocked.';
});
