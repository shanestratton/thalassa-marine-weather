import { beforeEach, describe, expect, it } from 'vitest';
import { ChartCatalogService, getLinzApiKey, setLinzApiKey, type ChartSource } from '../services/ChartCatalogService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const LINZ_STORAGE_KEY = 'thalassa_linz_api_key';
const CATALOG_STORAGE_KEY = 'thalassa_chart_catalog';

function linzSource(scope: AuthIdentityScope = getAuthIdentityScope()): ChartSource {
    const source = ChartCatalogService.getSources(scope).find((candidate) => candidate.id === 'linz-charts');
    if (!source) throw new Error('LINZ source missing');
    return source;
}

describe('ChartCatalogService identity boundary', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(`chart-test-${crypto.randomUUID()}`);
        ChartCatalogService.initialize();
    });

    it('keeps API-key overrides and chart preferences in the exact account namespace', () => {
        const accountA = getAuthIdentityScope();
        expect(ChartCatalogService.updateLinzKey('account-a-linz-secret', accountA)).toBe(true);
        ChartCatalogService.toggleSource('linz-charts', accountA);

        expect(localStorage.getItem(authScopedStorageKey(LINZ_STORAGE_KEY, accountA))).toBe('account-a-linz-secret');
        expect(localStorage.getItem(authScopedStorageKey(CATALOG_STORAGE_KEY, accountA))).toContain('linz-charts');

        const accountB = setAuthIdentityScope(`chart-test-b-${crypto.randomUUID()}`);
        const bSource = linzSource(accountB);

        expect(bSource.enabled).toBe(false);
        expect(bSource.tileUrl).not.toContain('account-a-linz-secret');
        expect(localStorage.getItem(authScopedStorageKey(LINZ_STORAGE_KEY, accountB))).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(CATALOG_STORAGE_KEY, accountB))).toBeNull();
    });

    it('rejects stale account callbacks without overwriting the active account', () => {
        const accountA = getAuthIdentityScope();
        expect(ChartCatalogService.updateLinzKey('account-a-original', accountA)).toBe(true);

        const accountB = setAuthIdentityScope(`chart-test-b-${crypto.randomUUID()}`);
        expect(ChartCatalogService.updateLinzKey('account-b-original', accountB)).toBe(true);

        expect(ChartCatalogService.updateLinzKey('stale-account-a-write', accountA)).toBe(false);
        ChartCatalogService.toggleSource('linz-charts', accountA);

        expect(getLinzApiKey(accountB)).toBe('account-b-original');
        expect(linzSource(accountB).tileUrl).toContain('account-b-original');
        expect(linzSource(accountB).enabled).toBe(false);
        expect(localStorage.getItem(authScopedStorageKey(LINZ_STORAGE_KEY, accountB))).toBe('account-b-original');
    });

    it('retires an unattributed legacy key instead of assigning it to the next login', () => {
        localStorage.setItem(LINZ_STORAGE_KEY, 'unowned-legacy-secret');

        const nextAccount = setAuthIdentityScope(`chart-test-next-${crypto.randomUUID()}`);

        expect(getLinzApiKey(nextAccount)).not.toBe('unowned-legacy-secret');
        expect(linzSource(nextAccount).tileUrl).not.toContain('unowned-legacy-secret');
        expect(localStorage.getItem(LINZ_STORAGE_KEY)).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(LINZ_STORAGE_KEY, nextAccount))).toBeNull();
    });

    it('validates overrides and URL-encodes accepted key material', () => {
        const scope = getAuthIdentityScope();

        expect(setLinzApiKey('short', scope)).toBe(false);
        expect(ChartCatalogService.updateLinzKey('abcdefgh/../../?access_token=evil', scope)).toBe(true);

        const url = linzSource(scope).tileUrl ?? '';
        expect(url).toContain('abcdefgh%2F..%2F..%2F%3Faccess_token%3Devil');
        expect(url).not.toContain('/../../?access_token=');
    });
});
