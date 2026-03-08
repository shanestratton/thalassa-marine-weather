/**
 * Seed Profiles for Crew Finder
 * 
 * Run this in the browser console or via a script to populate
 * the crew board with realistic starter profiles.
 * 
 * Usage: import { seedCrewProfiles } from './scripts/seedProfiles';
 *        await seedCrewProfiles();
 */

import { supabase } from '../services/supabase';

const SEED_PROFILES = [
    {
        user_id: '00000000-0000-4000-a000-000000000001',
        listing_type: 'seeking_crew',
        first_name: 'Marco',
        gender: 'Male',
        age_range: '36-45',
        has_partner: false,
        partner_details: null,
        skills: ['🧭 Navigation', '⚙️ Diesel Engines', '📐 Passage Planning', '🏥 First Aid'],
        sailing_experience: 'Bluewater Veteran',
        sailing_region: 'Mediterranean',
        available_from: '2026-04-01',
        available_to: '2026-12-31',
        bio: 'Commercial skipper with 80,000nm under the keel. Currently prepping a 52ft ketch for a Med season. Looking for crew who can cook, keep watch, and enjoy the ride. No drama, just good wind and great company.',
        vibe: ['🌴 Cruisy', '🧭 Explorer'],
        languages: ['🇬🇧 English', '🇮🇹 Italian', '🇫🇷 French'],
        smoking: 'Non-Smoker',
        drinking: 'Social Drinker',
        pets: 'No Pets',
        interests: ['⛵ Sailing', '🤿 Diving', '🍽️ Fine Dining', '🍷 Wine Time', '📸 Photography'],
        location_city: 'Palma',
        location_state: 'Mallorca',
        location_country: 'Spain',
        photo_url: 'https://randomuser.me/api/portraits/men/32.jpg',
        photos: ['https://randomuser.me/api/portraits/men/32.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000002',
        listing_type: 'seeking_berth',
        first_name: 'Sophie',
        gender: 'Female',
        age_range: '26-35',
        has_partner: false,
        partner_details: null,
        skills: ['🍳 Cooking', '🏥 First Aid', '👁️ Watch Keeping', '🐟 Fishing'],
        sailing_experience: 'Coastal Cruiser',
        sailing_region: 'Caribbean',
        available_from: '2026-05-01',
        available_to: '2026-09-30',
        bio: 'French chef turned ocean wanderer. Sailed the Atlantic twice, can bake bread at 30° heel. Looking for a boat heading anywhere warm with a galley I can make magic in.',
        vibe: ['🌅 Sundowner Vibes', '🎉 Social Butterfly'],
        languages: ['🇫🇷 French', '🇬🇧 English', '🇪🇸 Spanish'],
        smoking: 'Non-Smoker',
        drinking: 'Social Drinker',
        pets: 'No Pets',
        interests: ['🍳 Cooking', '🍽️ Fine Dining', '🤿 Snorkelling', '🧘 Yoga', '📖 Reading', '🌅 Sunsets'],
        location_city: 'Martinique',
        location_state: 'Caribbean',
        location_country: 'France',
        photo_url: 'https://randomuser.me/api/portraits/women/44.jpg',
        photos: ['https://randomuser.me/api/portraits/women/44.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000003',
        listing_type: 'seeking_crew',
        first_name: 'Dave',
        gender: 'Male',
        age_range: '56-65',
        has_partner: true,
        partner_details: 'Wife Jen sails with me — she does nav and sail trim',
        skills: ['🧭 Navigation', '⚙️ Diesel Engines', '⚡ Electrical', '🧰 Maintenance', '📐 Passage Planning'],
        sailing_experience: 'Salty Dog 🧂',
        sailing_region: 'Australia East Coast',
        available_from: '2026-03-15',
        available_to: '2099-12-31',
        bio: 'Retired engineer, full-time liveaboard. We\'ve been cruising the east coast of Australia for 5 years on our Beneteau 50. Looking for extra hands for the trip up to the Whitsundays. Cold beers guaranteed.',
        vibe: ['🌴 Cruisy', '🌅 Sundowner Vibes'],
        languages: ['🇬🇧 English'],
        smoking: 'Non-Smoker',
        drinking: 'Social Drinker',
        pets: '🐕 Dog Aboard',
        interests: ['🐟 Fishing', '🍺 Craft Beer', '🔧 Boat Work', '🐕 Dogs', '🌿 Nature'],
        location_city: 'Mooloolaba',
        location_state: 'Queensland',
        location_country: 'Australia',
        photo_url: 'https://randomuser.me/api/portraits/men/65.jpg',
        photos: ['https://randomuser.me/api/portraits/men/65.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000004',
        listing_type: 'seeking_berth',
        first_name: 'Mia',
        gender: 'Female',
        age_range: '18-25',
        has_partner: false,
        partner_details: null,
        skills: ['👁️ Watch Keeping', '🏥 First Aid', '🍳 Cooking', '📻 Radio/Comms'],
        sailing_experience: 'Weekend Warrior',
        sailing_region: 'Southeast Asia',
        available_from: '2026-06-01',
        available_to: '2026-11-30',
        bio: 'Kiwi backpacker learning to sail! Did my Yachtmaster Coastal last year and crewed on a delivery from Auckland to Fiji. Gap year vibes — looking for any boat heading through SE Asia. Will work hard, learn fast, bring good energy.',
        vibe: ['⚡ Adventurous', '🎉 Social Butterfly', '🧭 Explorer'],
        languages: ['🇬🇧 English'],
        smoking: 'Non-Smoker',
        drinking: 'Social Drinker',
        pets: 'No Pets',
        interests: ['🏄 Surfing', '🤿 Snorkelling', '🎪 Festivals', '📸 Photography', '🌍 Exploring New Places', '🎵 Music', '🧘 Yoga'],
        location_city: 'Auckland',
        location_state: 'North Island',
        location_country: 'New Zealand',
        photo_url: 'https://randomuser.me/api/portraits/women/28.jpg',
        photos: ['https://randomuser.me/api/portraits/women/28.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000005',
        listing_type: 'seeking_crew',
        first_name: 'Nikos',
        gender: 'Male',
        age_range: '46-55',
        has_partner: false,
        partner_details: null,
        skills: ['🧭 Navigation', '🪡 Sail Repair', '⛵ Rigging', '🐟 Fishing', '🍳 Cooking'],
        sailing_experience: 'Bluewater Veteran',
        sailing_region: 'Greece & Turkey',
        available_from: '2026-05-15',
        available_to: '2026-10-15',
        bio: 'Greek island skipper — been sailing these waters since I could walk. Running a 45ft sloop through the Cyclades and Dodecanese this summer. Proper sailing, no motors unless we have to. Can teach you everything.',
        vibe: ['🧘 Zen Sailor', '🌴 Cruisy'],
        languages: ['🇬🇷 Greek', '🇬🇧 English', '🇩🇪 German'],
        smoking: 'Social Smoker',
        drinking: 'Social Drinker',
        pets: '🐈 Cat Aboard',
        interests: ['🐟 Fishing', '🤿 Diving', '🍽️ Fine Dining', '🌅 Sunsets', '🧘 Meditation', '🎵 Music'],
        location_city: 'Athens',
        location_state: 'Attica',
        location_country: 'Greece',
        photo_url: 'https://randomuser.me/api/portraits/men/47.jpg',
        photos: ['https://randomuser.me/api/portraits/men/47.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000006',
        listing_type: 'seeking_berth',
        first_name: 'Jake',
        gender: 'Male',
        age_range: '26-35',
        has_partner: false,
        partner_details: null,
        skills: ['⚙️ Diesel Engines', '⚡ Electrical', '🧰 Maintenance', '🤿 Diving'],
        sailing_experience: 'Coastal Cruiser',
        sailing_region: 'Pacific / Australia',
        available_from: '2026-04-01',
        available_to: '2099-12-31',
        bio: 'Marine mechanic by trade, sailor by choice. Can fix anything with an engine and most things without one. Looking for a ride across the Pacific — happy to earn my berth keeping your boat running smooth.',
        vibe: ['⚡ Adventurous', '🧭 Explorer'],
        languages: ['🇬🇧 English'],
        smoking: 'Non-Smoker',
        drinking: 'Regular',
        pets: 'No Pets',
        interests: ['🔧 Boat Work', '🤿 Diving', '🐟 Fishing', '🍺 Craft Beer', '🏋️ Gym', '🎮 Gaming', '💻 Coding'],
        location_city: 'Cairns',
        location_state: 'Queensland',
        location_country: 'Australia',
        photo_url: 'https://randomuser.me/api/portraits/men/22.jpg',
        photos: ['https://randomuser.me/api/portraits/men/22.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000007',
        listing_type: 'seeking_berth',
        first_name: 'Isabella',
        gender: 'Female',
        age_range: '36-45',
        has_partner: true,
        partner_details: 'Partner Tom — experienced sailor, can do watches and nav',
        skills: ['🍳 Cooking', '🏥 First Aid', '📻 Radio/Comms', '🎣 Provisioning', '👁️ Watch Keeping'],
        sailing_experience: 'Liveaboard',
        sailing_region: 'Anywhere warm',
        available_from: '2026-07-01',
        available_to: '2099-12-31',
        bio: 'We sold the house, quit the jobs, and bought a one-way ticket. Looking for a captain heading offshore who needs a reliable couple. We bring our own foulies, a good attitude, and a cracking playlist.',
        vibe: ['🌴 Cruisy', '🌅 Sundowner Vibes', '🎉 Social Butterfly'],
        languages: ['🇬🇧 English', '🇪🇸 Spanish', '🇵🇹 Portuguese'],
        smoking: 'Non-Smoker',
        drinking: 'Social Drinker',
        pets: 'No Pets',
        interests: ['🍷 Wine Time', '🍽️ Fine Dining', '🏝️ Island Hopping', '📸 Photography', '🌍 Exploring New Places', '💃 Dancing', '🚗 Weekend Getaways'],
        location_city: 'Lisbon',
        location_state: '',
        location_country: 'Portugal',
        photo_url: 'https://randomuser.me/api/portraits/women/33.jpg',
        photos: ['https://randomuser.me/api/portraits/women/33.jpg'],
    },
    {
        user_id: '00000000-0000-4000-a000-000000000008',
        listing_type: 'seeking_crew',
        first_name: 'Captain Salty',
        gender: 'Male',
        age_range: '65+',
        has_partner: false,
        partner_details: null,
        skills: ['🧭 Navigation', '⚙️ Diesel Engines', '⚡ Electrical', '🪡 Sail Repair', '⛵ Rigging', '📐 Passage Planning'],
        sailing_experience: 'Salty Dog 🧂',
        sailing_region: 'Worldwide',
        available_from: '2026-01-01',
        available_to: '2099-12-31',
        bio: 'Three circumnavigations, two Hobarts, and more rum than I care to admit. My Hallberg-Rassy is my home and she needs a fresh pair of hands. Teach you everything I know in exchange for good company and someone to argue with about the weather.',
        vibe: ['🧘 Zen Sailor', '🧭 Explorer'],
        languages: ['🇬🇧 English', '🇫🇷 French'],
        smoking: 'Non-Smoker',
        drinking: 'Regular',
        pets: '🐈 Cat Aboard',
        interests: ['⛵ Sailing', '📖 Reading', '🍷 Wine Time', '🎵 Music', '🐈 Cats', '🌅 Sunsets', '🐟 Fishing'],
        location_city: 'Hobart',
        location_state: 'Tasmania',
        location_country: 'Australia',
        photo_url: 'https://randomuser.me/api/portraits/men/78.jpg',
        photos: ['https://randomuser.me/api/portraits/men/78.jpg'],
    },
];

/**
 * Insert seed profiles into Supabase.
 * Also creates matching chat_profiles with looking_for_love = true.
 * Call removeSeedProfiles() to clean up later.
 */
export async function seedCrewProfiles(): Promise<{ inserted: number; errors: string[] }> {
    if (!supabase) return { inserted: 0, errors: ['Supabase not initialized'] };

    const errors: string[] = [];
    let inserted = 0;

    for (const profile of SEED_PROFILES) {
        // 1. Upsert crew profile first (main data)
        const { error: crewError } = await supabase
            .from('sailor_crew_profiles')
            .upsert({
                ...profile,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

        if (crewError) {
            errors.push(`${profile.first_name}: ${crewError.message}`);
            continue;
        }
        inserted++;

        // 2. Try chat_profile (best-effort — may fail due to FK constraints)
        const chatProfile = {
            user_id: profile.user_id,
            display_name: profile.first_name,
            avatar_url: profile.photo_url,
            vessel_name: profile.listing_type === 'seeking_crew' ? `SV ${profile.first_name}'s Boat` : null,
            home_port: `${profile.location_city}, ${profile.location_country}`,
            looking_for_love: true,
        };

        const { error: chatError } = await supabase
            .from('chat_profiles')
            .upsert(chatProfile, { onConflict: 'user_id' });

        if (chatError) {
            // Non-fatal — crew profile still inserted
            console.warn(`[Seed] chat_profile for ${profile.first_name} skipped: ${chatError.message}`);
        }
    }

    return { inserted, errors };
}

/**
 * Remove all seed profiles from Supabase.
 */
export async function removeSeedProfiles(): Promise<{ removed: number; errors: string[] }> {
    if (!supabase) return { removed: 0, errors: ['Supabase not initialized'] };

    const seedIds = SEED_PROFILES.map(p => p.user_id);
    const errors: string[] = [];
    let removed = 0;

    // Remove crew profiles
    const { error: crewError } = await supabase
        .from('sailor_crew_profiles')
        .delete()
        .in('user_id', seedIds);
    if (crewError) errors.push(`Crew cleanup: ${crewError.message}`);

    // Remove chat profiles
    const { error: chatError } = await supabase
        .from('chat_profiles')
        .delete()
        .in('user_id', seedIds);
    if (chatError) errors.push(`Chat cleanup: ${chatError.message}`);
    else removed = seedIds.length;

    // Remove any likes involving seed users
    const { error: likesError } = await supabase
        .from('sailor_likes')
        .delete()
        .or(seedIds.map(id => `liker_id.eq.${id},liked_id.eq.${id}`).join(','));
    if (likesError) errors.push(`Likes cleanup: ${likesError.message}`);

    return { removed, errors };
}

/** Check if seed profiles exist */
export function getSeedUserIds(): string[] {
    return SEED_PROFILES.map(p => p.user_id);
}
