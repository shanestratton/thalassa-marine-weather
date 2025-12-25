
import { createClient } from '@supabase/supabase-js';

const logConfig = (msg: string) => console.log(`[Supabase Config] ${msg}`);

const getUrl = () => {
    let url = "";
    
    // 1. Try Vite native
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL) {
        url = import.meta.env.VITE_SUPABASE_URL as string;
        logConfig("Found URL in import.meta.env.VITE_SUPABASE_URL");
    } else {
        logConfig("❌ Not found in import.meta.env.VITE_SUPABASE_URL");
    }
    
    // 2. Try Process Env (Direct access required for replacement)
    if (!url) {
        try {
            // @ts-ignore
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) {
                // @ts-ignore
                url = process.env.SUPABASE_URL;
                logConfig("Found URL in process.env.SUPABASE_URL");
            }
        } catch (e) {}
    }
    
    return url;
};

const getKey = () => {
    let key = "";
    
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_KEY) {
        key = import.meta.env.VITE_SUPABASE_KEY as string;
        logConfig("Found KEY in import.meta.env.VITE_SUPABASE_KEY");
    } else {
        logConfig("❌ Not found in import.meta.env.VITE_SUPABASE_KEY");
    }
    
    if (!key) {
        try {
            // @ts-ignore
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_KEY) {
                // @ts-ignore
                key = process.env.SUPABASE_KEY;
                logConfig("Found KEY in process.env.SUPABASE_KEY");
            }
        } catch (e) {}
    }
    
    return key;
};

const URL = getUrl();
const KEY = getKey();

if (URL && KEY) {
    console.log("Supabase Status: Initializing Client...");
} else {
    console.log("Supabase Status: Credentials Missing - Sync Disabled");
    if (!URL) logConfig("MISSING: Supabase URL");
    if (!KEY) logConfig("MISSING: Supabase Anon Key");
}

// Only create client if keys are present
export const supabase = (URL && KEY) ? createClient(URL, KEY) : null;

export const isSupabaseConfigured = () => !!supabase;
