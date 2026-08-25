export const FOUNDING_SKIPPER_STATUSES = ['new', 'contacted', 'accepted', 'declined', 'withdrawn'] as const;

export type FoundingSkipperStatus = (typeof FOUNDING_SKIPPER_STATUSES)[number];

export interface FoundingSkipperApplicationRecord {
    id: string;
    name: string;
    email: string;
    boat_type: 'sail_monohull' | 'sail_multihull' | 'power' | 'trailer_boat' | 'other';
    home_waters: string;
    apple_device: 'iphone' | 'ipad' | 'iphone_and_ipad';
    boating_frequency: 'weekly_plus' | 'fortnightly' | 'monthly' | 'less_often';
    interests: string[];
    notes: string | null;
    source: string;
    consent_version: string;
    consented_at: string;
    status: FoundingSkipperStatus;
    status_updated_at: string | null;
    status_updated_by: string | null;
    created_at: string;
    expires_at: string;
}

export interface FoundingSkipperCursor {
    createdAt: string;
    id: string;
}

export interface FoundingSkipperPage {
    applications: FoundingSkipperApplicationRecord[];
    nextCursor: FoundingSkipperCursor | null;
}
