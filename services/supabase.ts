
import { createClient } from '@supabase/supabase-js';

const logConfig = (msg: string) => { };

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
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) {
                url = process.env.SUPABASE_URL;
                logConfig("Found URL in process.env.SUPABASE_URL");
            }
        } catch { /* process.env may not exist in browser */ }
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
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_KEY) {
                key = process.env.SUPABASE_KEY;
                logConfig("Found KEY in process.env.SUPABASE_KEY");
            }
        } catch { /* process.env may not exist in browser */ }
    }

    return key;
};

const URL = getUrl();
const KEY = getKey();

if (URL && KEY) {

} else {

    if (!URL) logConfig("MISSING: Supabase URL");
    if (!KEY) logConfig("MISSING: Supabase Anon Key");
}

// Only create client if keys are present
export const supabase = (URL && KEY) ? createClient(URL, KEY) : null;

export const isSupabaseConfigured = () => !!supabase;
