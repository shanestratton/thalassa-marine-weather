import { describe, expect, it, vi } from 'vitest';
import { scrollChatToLatest } from '../components/chat/scrollChatToLatest';

describe('chat history scroll ownership', () => {
    it('scrolls the message history without moving the page or input composer', () => {
        const shell = document.createElement('div');
        const history = document.createElement('div');
        const marker = document.createElement('div');
        history.dataset.chatScroll = '';
        shell.append(history);
        history.append(marker);
        Object.defineProperty(history, 'scrollHeight', { value: 2400 });
        history.scrollTo = vi.fn();
        shell.scrollTo = vi.fn();
        marker.scrollIntoView = vi.fn();
        scrollChatToLatest(marker);
        expect(history.scrollTo).toHaveBeenCalledWith({ top: 2400, behavior: 'auto' });
        scrollChatToLatest(marker, 'smooth');
        expect(history.scrollTo).toHaveBeenLastCalledWith({ top: 2400, behavior: 'smooth' });
        expect(shell.scrollTo).not.toHaveBeenCalled();
        expect(marker.scrollIntoView).not.toHaveBeenCalled();
    });

    it('does nothing for a detached/unmounted marker rather than scrolling a generic ancestor', () => {
        const marker = document.createElement('div');
        marker.scrollIntoView = vi.fn();
        scrollChatToLatest(marker);
        scrollChatToLatest(null);
        expect(marker.scrollIntoView).not.toHaveBeenCalled();
    });
});
