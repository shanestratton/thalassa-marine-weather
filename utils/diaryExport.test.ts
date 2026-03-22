/**
 * diaryExport — Unit tests for diary export data structures.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock all heavy dependencies
vi.mock('../services/supabase', () => ({
    supabase: { storage: { from: vi.fn(() => ({ getPublicUrl: vi.fn(() => ({ data: { publicUrl: '' } })) })) } },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// The module exports constants for diary export PDF
describe('diaryExport module', () => {
    it('can be imported without errors', async () => {
        const mod = await import('./diaryExport');
        expect(mod).toBeDefined();
    });
});
