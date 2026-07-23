declare module 'jsdom' {
    export type DOMWindow = Window &
        typeof globalThis & {
            close(): void;
        };

    export interface ConstructorOptions {
        url?: string;
        runScripts?: 'dangerously' | 'outside-only';
        beforeParse?: (window: DOMWindow) => void;
    }

    export class JSDOM {
        constructor(html?: string, options?: ConstructorOptions);
        readonly window: DOMWindow;
    }
}
