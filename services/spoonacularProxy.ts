import { supabase } from './supabase';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

export type SpoonacularOperation = 'information' | 'bulk' | 'mealplan' | 'search';

export async function fetchSpoonacular(
    operation: SpoonacularOperation,
    payload: Record<string, unknown> = {},
): Promise<unknown | null> {
    // Beta kill switch: do not even contact the Edge Function while the paid
    // provider is disabled. This protects every current and future caller.
    if (!FEATURE_VISIBILITY.spoonacular || !supabase) return null;
    try {
        const { data, error } = await supabase.functions.invoke('proxy-spoonacular', {
            body: { operation, ...payload },
        });
        return error || data == null ? null : data;
    } catch {
        return null;
    }
}
