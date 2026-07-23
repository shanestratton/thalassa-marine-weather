import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeImage } from '../components/ui/SafeImage';
import { cacheRecipeImage } from '../services/GalleyRecipeService';
import { safeImageUrl } from '../utils/safeUrl';

afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('SafeImage privacy boundary', () => {
    it('fails closed for scriptable, credentialed, cleartext, and foreign blob sources', () => {
        const hostileSources = [
            'javascript:globalThis.pwned=1',
            'data:image/svg+xml,<svg onload="globalThis.pwned=1"/>',
            'https://trusted.example.test@evil.example.test/avatar.jpg',
            'http://tracking.example.test/pixel.gif',
            'blob:https://evil.example.test/non/root/avatar',
            '//tracking.example.test/pixel.gif',
        ];

        for (const [index, src] of hostileSources.entries()) {
            const { unmount } = render(
                <SafeImage
                    src={src}
                    alt={`hostile-${index}`}
                    fallback={<span data-testid={`fallback-${index}`}>fallback</span>}
                />,
            );
            expect(screen.queryByRole('img', { name: `hostile-${index}` })).toBeNull();
            expect(screen.getByTestId(`fallback-${index}`)).toBeInTheDocument();
            unmount();
        }
    });

    it('renders credential-free HTTPS with no referrer and privacy-safe loading defaults', () => {
        render(<SafeImage src="https://cdn.example.test/avatar.webp" alt="Safe avatar" />);

        const image = screen.getByRole('img', { name: 'Safe avatar' });
        expect(image).toHaveAttribute('src', 'https://cdn.example.test/avatar.webp');
        expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
        expect(image).toHaveAttribute('loading', 'lazy');
        expect(image).toHaveAttribute('decoding', 'async');
    });

    it('preserves local, offline, and non-root same-origin blob images', () => {
        expect(safeImageUrl('/assets/avatar.webp', 'https://app.example.test/nested/page')).toBe('/assets/avatar.webp');
        expect(safeImageUrl('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
        expect(
            safeImageUrl(
                'blob:https://app.example.test/non/root/path/avatar-id',
                'https://app.example.test/nested/page?tab=profile',
            ),
        ).toBe('blob:https://app.example.test/non/root/path/avatar-id');
        expect(
            safeImageUrl('blob:capacitor://localhost/non/root/path/avatar-id', 'capacitor://localhost/app/profile'),
        ).toBe('blob:capacitor://localhost/non/root/path/avatar-id');
    });

    it('permits cleartext only for same-origin or explicitly opted-in boat LAN hosts', () => {
        expect(safeImageUrl('http://app.test:8080/photo.jpg', 'http://app.test:8080/nested/page')).toBe(
            'http://app.test:8080/photo.jpg',
        );
        expect(
            safeImageUrl('http://calypso.local:3001/cache/tile.png', 'capacitor://localhost/app', {
                allowLocalNetworkHttp: true,
            }),
        ).toBe('http://calypso.local:3001/cache/tile.png');
        expect(
            safeImageUrl('http://192.168.50.7:3001/cache/tile.png', 'capacitor://localhost/app', {
                allowLocalNetworkHttp: true,
            }),
        ).toBe('http://192.168.50.7:3001/cache/tile.png');
        expect(
            safeImageUrl('http://tracking.example.test/pixel.gif', 'capacitor://localhost/app', {
                allowLocalNetworkHttp: true,
            }),
        ).toBeNull();
    });

    it('validates image-cache fetches and omits credentials and referrers', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            blob: async () => new Blob(['png'], { type: 'image/png' }),
        } as Response);

        await expect(
            cacheRecipeImage('https://trusted.example.test@tracker.example.test/pixel.png', 9001),
        ).resolves.toBe('');
        expect(fetchSpy).not.toHaveBeenCalled();

        const cached = await cacheRecipeImage('https://cdn.example.test/recipe.png', 9002);
        expect(cached).toMatch(/^data:image\/png;base64,/);
        expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example.test/recipe.png', {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
    });
});
