/**
 * lazyRetry — Unit tests for lazy-load with retry utility.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { lazyRetry } from './lazyRetry';

describe('lazyRetry', () => {
    it('returns a React.lazy component', () => {
        const Component = lazyRetry(
            () => Promise.resolve({ default: (() => null) as unknown as React.ComponentType }),
            'TestComponent',
        );
        expect(Component).toBeDefined();
        // React.lazy returns an object with $$typeof
        expect(Component.$$typeof).toBeDefined();
    });

    it('passes through the factory function', async () => {
        const factory = vi.fn().mockResolvedValue({
            default: (() => null) as unknown as React.ComponentType,
        });
        const Component = lazyRetry(factory, 'TestComponent');
        expect(Component).toBeDefined();
    });

    it('works without a name parameter', () => {
        const Component = lazyRetry(() => Promise.resolve({ default: (() => null) as unknown as React.ComponentType }));
        expect(Component).toBeDefined();
    });
});
