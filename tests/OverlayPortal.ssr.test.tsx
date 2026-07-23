import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OverlayPortal } from '../components/ui/OverlayPortal';

describe('OverlayPortal SSR fallback', () => {
    it('renders inline without a document body', () => {
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: undefined,
        });

        try {
            const html = renderToString(
                <OverlayPortal>
                    <p>Server-safe overlay</p>
                </OverlayPortal>,
            );

            expect(html).toContain('data-overlay-layer="modal"');
            expect(html).toContain('Server-safe overlay');
        } finally {
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
        }
    });
});
