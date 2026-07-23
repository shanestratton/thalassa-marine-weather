import { supabase } from './supabase';

export type SpoonacularOperation = 'information' | 'bulk' | 'mealplan' | 'search';

export async function fetchSpoonacular(
    operation: SpoonacularOperation,
    payload: Record<string, unknown> = {},
): Promise<unknown | null> {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.functions.invoke('proxy-spoonacular', {
            body: { operation, ...payload },
        });
        return error || data == null ? null : data;
    } catch {
        return null;
    }
}
