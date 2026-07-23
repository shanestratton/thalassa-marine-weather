import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    storageFrom: vi.fn(),
    storageUpload: vi.fn(),
    getPublicUrl: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
    compressImage: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser },
        from: mocks.from,
        rpc: mocks.rpc,
        storage: { from: mocks.storageFrom },
        channel: mocks.channel,
        removeChannel: mocks.removeChannel,
    },
}));

vi.mock('../services/ProfilePhotoService', () => ({
    compressImage: mocks.compressImage,
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { MarketplaceService, type MarketplaceListing } from '../services/MarketplaceService';
import { SellerRatingService, type SellerRating, type SellerReputation } from '../services/SellerRatingService';

const authResult = (userId: string | null) => ({
    data: { user: userId ? { id: userId } : null },
    error: null,
});

function listing(id: string, sellerId = 'account-a'): MarketplaceListing {
    return {
        id,
        seller_id: sellerId,
        title: `Listing ${id}`,
        description: null,
        price: 100,
        currency: 'AUD',
        category: 'Safety',
        condition: 'Used - Good',
        images: [],
        location_name: null,
        status: 'available',
        sold_at: null,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

function rating(id: string, buyerId = 'account-a'): SellerRating {
    return {
        id,
        listing_id: 'listing-1',
        seller_id: 'seller-1',
        buyer_id: buyerId,
        stars: 5,
        comment: null,
        created_at: '2026-07-23T00:00:00.000Z',
    };
}

describe('marketplace identity isolation', () => {
    beforeEach(() => {
        MarketplaceService.destroy();
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue(authResult('account-a'));
        mocks.compressImage.mockResolvedValue(new Blob(['compressed'], { type: 'image/jpeg' }));
        mocks.storageFrom.mockReturnValue({
            upload: mocks.storageUpload,
            getPublicUrl: mocks.getPublicUrl,
        });
        mocks.storageUpload.mockResolvedValue({ error: null });
        mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: 'https://example.test/photo.jpg' } });
    });

    it('switches both singleton owners synchronously and ignores late initialization from A', async () => {
        const marketplaceAuth = deferred<ReturnType<typeof authResult>>();
        const ratingAuth = deferred<ReturnType<typeof authResult>>();
        mocks.getUser.mockReset().mockReturnValueOnce(marketplaceAuth.promise).mockReturnValueOnce(ratingAuth.promise);

        const marketplaceInit = MarketplaceService.initialize();
        const ratingInit = SellerRatingService.initialize();
        await vi.waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(2));

        setAuthIdentityScope('account-b');
        expect(MarketplaceService.getCurrentUserId()).toBe('account-b');
        expect(SellerRatingService.getCurrentUserId()).toBe('account-b');

        marketplaceAuth.resolve(authResult('account-a'));
        ratingAuth.resolve(authResult('account-a'));
        await Promise.all([marketplaceInit, ratingInit]);

        expect(MarketplaceService.getCurrentUserId()).toBe('account-b');
        expect(SellerRatingService.getCurrentUserId()).toBe('account-b');
    });

    it('discards an A my-listings response that resolves after B becomes current', async () => {
        const remoteRows = deferred<{ data: MarketplaceListing[]; error: null }>();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(remoteRows.promise);
        mocks.from.mockReturnValue(query);

        const pending = MarketplaceService.getMyListings();
        await vi.waitFor(() => expect(query.order).toHaveBeenCalledTimes(1));
        expect(query.eq).toHaveBeenCalledWith('seller_id', 'account-a');

        setAuthIdentityScope('account-b');
        remoteRows.resolve({ data: [listing('late-a')], error: null });

        await expect(pending).resolves.toEqual([]);
        expect(mocks.from).toHaveBeenCalledTimes(1);
    });

    it('does not upload an A photo after compression completes under B', async () => {
        const compressed = deferred<Blob>();
        mocks.compressImage.mockReturnValue(compressed.promise);
        const file = new File(['original'], 'listing.jpg', { type: 'image/jpeg' });

        const pending = MarketplaceService.uploadImage(file);
        await vi.waitFor(() => expect(mocks.compressImage).toHaveBeenCalledWith(file));

        setAuthIdentityScope('account-b');
        compressed.resolve(new Blob(['late-a'], { type: 'image/jpeg' }));

        await expect(pending).resolves.toBeNull();
        expect(mocks.storageUpload).not.toHaveBeenCalled();
    });

    it('uses the captured A seller for create and discards its late result under B', async () => {
        const remoteInsert = deferred<{ data: MarketplaceListing; error: null }>();
        const query = {
            insert: vi.fn(),
            select: vi.fn(),
            single: vi.fn(),
        };
        query.insert.mockReturnValue(query);
        query.select.mockReturnValue(query);
        query.single.mockReturnValue(remoteInsert.promise);
        mocks.from.mockReturnValue(query);

        const pending = MarketplaceService.createListing({
            title: 'Account A EPIRB',
            price: 500,
            category: 'Safety',
            condition: 'Used - Good',
        });
        await vi.waitFor(() => expect(query.single).toHaveBeenCalledTimes(1));
        expect(query.insert).toHaveBeenCalledWith(
            expect.objectContaining({ seller_id: 'account-a', title: 'Account A EPIRB' }),
        );

        setAuthIdentityScope('account-b');
        remoteInsert.resolve({ data: listing('created-by-a'), error: null });

        await expect(pending).resolves.toBeNull();
    });

    it('fences a late A delete and always constrains it to the captured seller', async () => {
        const remoteDelete = deferred<{ error: null }>();
        const query = {
            delete: vi.fn(),
            eq: vi.fn(),
        };
        query.delete.mockReturnValue(query);
        query.eq.mockReturnValueOnce(query).mockReturnValueOnce(remoteDelete.promise);
        mocks.from.mockReturnValue(query);

        const pending = MarketplaceService.deleteListing('listing-a');
        await vi.waitFor(() => expect(query.eq).toHaveBeenCalledTimes(2));
        expect(query.eq).toHaveBeenNthCalledWith(1, 'id', 'listing-a');
        expect(query.eq).toHaveBeenNthCalledWith(2, 'seller_id', 'account-a');

        setAuthIdentityScope('account-b');
        remoteDelete.resolve({ error: null });

        await expect(pending).resolves.toBe(false);
    });

    it('does not issue a marketplace mutation when remote auth disagrees with the fence', async () => {
        setAuthIdentityScope('account-b');
        mocks.getUser.mockResolvedValue(authResult('account-a'));

        await expect(MarketplaceService.markSold('listing-b')).resolves.toBe(false);
        expect(mocks.from).not.toHaveBeenCalled();
    });
});

describe('seller rating identity isolation', () => {
    beforeEach(() => {
        MarketplaceService.destroy();
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue(authResult('account-a'));
    });

    it('returns a neutral reputation when A ratings resolve after the switch to B', async () => {
        const remoteRatings = deferred<{ data: SellerRating[]; error: null }>();
        const query = {
            select: vi.fn(),
            eq: vi.fn(),
            order: vi.fn(),
            limit: vi.fn(),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        query.order.mockReturnValue(query);
        query.limit.mockReturnValue(remoteRatings.promise);
        mocks.from.mockReturnValue(query);

        const pending = SellerRatingService.getSellerReputation('seller-1');
        await vi.waitFor(() => expect(query.limit).toHaveBeenCalledWith(20));

        setAuthIdentityScope('account-b');
        remoteRatings.resolve({ data: [rating('late-a-rating')], error: null });

        const expected: SellerReputation = {
            seller_id: 'seller-1',
            avg_stars: 0,
            total_ratings: 0,
            recent_ratings: [],
        };
        await expect(pending).resolves.toEqual(expected);
    });

    it('captures buyer A in a rating and discards the result after B becomes current', async () => {
        const remoteInsert = deferred<{ data: SellerRating; error: null }>();
        const query = {
            insert: vi.fn(),
            select: vi.fn(),
            single: vi.fn(),
        };
        query.insert.mockReturnValue(query);
        query.select.mockReturnValue(query);
        query.single.mockReturnValue(remoteInsert.promise);
        mocks.from.mockReturnValue(query);

        const pending = SellerRatingService.rateSeller('listing-1', 'seller-1', 8, '  Great seller  ');
        await vi.waitFor(() => expect(query.single).toHaveBeenCalledTimes(1));
        expect(query.insert).toHaveBeenCalledWith({
            listing_id: 'listing-1',
            seller_id: 'seller-1',
            buyer_id: 'account-a',
            stars: 5,
            comment: 'Great seller',
        });

        setAuthIdentityScope('account-b');
        remoteInsert.resolve({ data: rating('rating-a'), error: null });

        await expect(pending).resolves.toBeNull();
    });

    it('fences a late A rating delete and constrains it to buyer A', async () => {
        const remoteDelete = deferred<{ error: null }>();
        const query = {
            delete: vi.fn(),
            eq: vi.fn(),
        };
        query.delete.mockReturnValue(query);
        query.eq.mockReturnValueOnce(query).mockReturnValueOnce(remoteDelete.promise);
        mocks.from.mockReturnValue(query);

        const pending = SellerRatingService.deleteRating('rating-a');
        await vi.waitFor(() => expect(query.eq).toHaveBeenCalledTimes(2));
        expect(query.eq).toHaveBeenNthCalledWith(1, 'id', 'rating-a');
        expect(query.eq).toHaveBeenNthCalledWith(2, 'buyer_id', 'account-a');

        setAuthIdentityScope('account-b');
        remoteDelete.resolve({ error: null });

        await expect(pending).resolves.toBe(false);
    });

    it('does not issue a rating write when remote auth belongs to another account', async () => {
        setAuthIdentityScope('account-b');
        mocks.getUser.mockResolvedValue(authResult('account-a'));

        await expect(SellerRatingService.rateSeller('listing-1', 'seller-1', 5)).resolves.toBeNull();
        expect(mocks.from).not.toHaveBeenCalled();
    });
});
