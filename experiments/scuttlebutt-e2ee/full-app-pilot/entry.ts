/** Separate Research entry only. Deny before dynamic App/provider/SDK imports. */
import { requireNativePrivateMessagesForProcess } from '../../../services/chat/e2ee/privateMessageCutover';
import { createFullAppIoFence } from './ioFence';
requireNativePrivateMessagesForProcess();
try {
    const fence = createFullAppIoFence(window);
    fence.install();
    void import('./sdk')
        .then(async ({ createFullAppRuntimeFactory }) => {
            // Configure the honest App platform projection before any App/store
            // module evaluates. This creates no SDK client or Auth controller.
            const factory = createFullAppRuntimeFactory(fence.researchAuthFetch);
            const { mountFullAppResearch } = await import('./main');
            mountFullAppResearch(factory);
        })
        .catch(() => {
            const target = document.getElementById('root');
            if (target) target.textContent = 'Full App Research unavailable. Legacy sending remains blocked.';
        });
} catch {
    const target = document.getElementById('root');
    if (target) target.textContent = 'Full App Research isolation unavailable. Legacy sending remains blocked.';
}
