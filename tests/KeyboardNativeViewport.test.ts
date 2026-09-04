import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { getKeyboardViewport, initGlobalKeyboardScroll, subscribeKeyboardHeight } from '../utils/keyboardScroll';

const native = vi.hoisted(() => ({
    callbacks: new Map<string, (info: { keyboardHeight: number }) => void>(),
    remove: vi.fn(),
}));
vi.mock('@capacitor/keyboard', () => ({
    Keyboard: {
        addListener: vi.fn(async (name: string, callback: (info: { keyboardHeight: number }) => void) => {
            native.callbacks.set(name, callback);
            return {
                remove: async () => {
                    native.callbacks.delete(name);
                    native.remove();
                },
            };
        }),
    },
}));

const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
let stop: (() => void) | undefined;
afterEach(() => {
    stop?.();
    stop = undefined;
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight);
    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
    native.callbacks.clear();
    vi.clearAllMocks();
});

describe('native overlay keyboard geometry', () => {
    it('uses native height when KeyboardResize.None leaves the browser viewport full-sized', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
        const seen = vi.fn();
        stop = subscribeKeyboardHeight(seen);
        await vi.dynamicImportSettled();
        native.callbacks.get('keyboardWillShow')!({ keyboardHeight: 344 });
        expect(getKeyboardViewport()).toMatchObject({ bottom: 480, keyboardHeight: 344 });
        expect(seen).toHaveBeenLastCalledWith(344);
        native.callbacks.get('keyboardDidShow')!({ keyboardHeight: 360 });
        expect(getKeyboardViewport().bottom).toBe(464);
        native.callbacks.get('keyboardDidHide')!({ keyboardHeight: 0 });
        expect(seen).toHaveBeenLastCalledWith(0);
        expect(document.documentElement.dataset.keyboardOpen).toBe('false');
        stop();
        stop = undefined;
        expect(native.remove).toHaveBeenCalledTimes(4);
    });

    it('does not stack another native keyboard listener set for each mounted form', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        stop = initGlobalKeyboardScroll();
        const stopSecond = subscribeKeyboardHeight(() => {});
        await vi.dynamicImportSettled();
        expect(native.callbacks.size).toBe(4);
        stopSecond();
        expect(native.remove).not.toHaveBeenCalled();
        stop();
        stop = undefined;
        expect(native.remove).toHaveBeenCalledTimes(4);
    });
});
