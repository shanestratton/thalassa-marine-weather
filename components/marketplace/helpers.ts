/**
 * Marketplace shared helpers — used by ListingCard, CreateListingModal, MarketplacePage
 */

/** Haversine distance in nautical miles between two lat/lon pairs */
export const haversineNm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3440.065; // Earth radius in nm
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
};

export const timeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
};

export const formatPrice = (price: number, currency: string): string => {
    const symbols: Record<string, string> = { AUD: 'A$', USD: '$', EUR: '€', GBP: '£', NZD: 'NZ$' };
    const sym = symbols[currency] || `${currency} `;
    return price % 1 === 0 ? `${sym}${price.toLocaleString()}` : `${sym}${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const getConditionColor = (condition: string): string => {
    switch (condition) {
        case 'New': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'Like New': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
        case 'Used - Good': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        case 'Used - Fair': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        case 'Needs Repair': return 'text-red-400 bg-red-500/10 border-red-500/20';
        default: return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
    }
};

export const AVATAR_GRADIENTS = [
    'from-sky-400 to-sky-600', 'from-emerald-400 to-emerald-600', 'from-purple-400 to-purple-600',
    'from-red-400 to-red-600', 'from-amber-400 to-amber-600', 'from-sky-400 to-sky-600',
];

export const getAvatarGradient = (id: string): string => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) { hash = ((hash << 5) - hash) + id.charCodeAt(i); hash |= 0; }
    return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
};

export const MAX_PHOTOS = 20;
