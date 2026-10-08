/** jsdom rendering gaps only. No production/native/Supabase success mocks. */
import '@testing-library/jest-dom';
import { vi } from 'vitest';
Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
            return false;
        },
    })),
});
class IdleObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}
vi.stubGlobal('ResizeObserver', IdleObserver);
vi.stubGlobal('IntersectionObserver', IdleObserver);
