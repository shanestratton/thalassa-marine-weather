/** Scroll only the message history. scrollIntoView can also move the clipped
 * app shell, hiding its header/composer after a keyboard or history update. */
export function scrollChatToLatest(marker: HTMLElement | null, behavior: ScrollBehavior = 'auto'): void {
    const history = marker?.closest<HTMLElement>('[data-chat-scroll]');
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
}
