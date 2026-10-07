/**
 * Forget a click React left in window.event. After React 18's development
 * build handles a click it writes window.event back (invokeGuardedCallbackDev),
 * and under vitest that write lands in the global's own setter, so
 * window.event reads as that click for the rest of the file. React ranks an
 * update made outside any event by window.event, so every later fetch answer
 * rendered as if clicked, synchronously: the tests after the first click
 * never met the scheduling a phone, or a cold CI runner, gives them.
 *
 * Call it in beforeEach, so every test meets real scheduling whatever ran
 * before it.
 */
export function clearStaleWindowEvent(): void {
    (window as unknown as { event: Event | undefined }).event = undefined;
}
