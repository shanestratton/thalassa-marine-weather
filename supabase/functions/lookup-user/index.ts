/**
 * lookup-user — Supabase Edge Function
 *
 * Looks up a user by email address using the service_role key.
 * Used by the Crew Sharing feature to find crew members by email.
 *
 * Requires authentication — only logged-in users can look up other users.
 * Returns minimal info (user_id, email) — no sensitive data exposed.
 *
 * Required Secrets:
 * - SUPABASE_URL: Auto-provided
 * - SUPABASE_SERVICE_ROLE_KEY: Auto-provided
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        // Verify the caller is authenticated
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: "Missing authorization header" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Create a client with the caller's JWT to verify they're logged in
        const anonClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user: caller }, error: authError } = await anonClient.auth.getUser();
        if (authError || !caller) {
            return new Response(
                JSON.stringify({ error: "Not authenticated" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Parse request
        const { email } = await req.json();
        if (!email || typeof email !== "string") {
            return new Response(
                JSON.stringify({ error: "Missing email parameter" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Prevent looking up yourself
        if (email.toLowerCase() === caller.email?.toLowerCase()) {
            return new Response(
                JSON.stringify({ found: false, reason: "self" }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Use service_role to query auth.users (client-side can't do this)
        const adminClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // List users filtered by email (admin API)
        const { data: listData, error: listError } = await adminClient.auth.admin.listUsers({
            page: 1,
            perPage: 1,
        });

        if (listError) {
            console.error("[lookup-user] Admin list error:", listError.message);
            return new Response(
                JSON.stringify({ error: "Lookup failed" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Search through users for the email match
        // Note: For large user bases, you'd want a direct SQL query instead
        const { data: allUsers } = await adminClient.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
        });

        const targetUser = allUsers?.users?.find(
            (u) => u.email?.toLowerCase() === email.toLowerCase()
        );

        if (!targetUser) {
            return new Response(
                JSON.stringify({ found: false }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({
                found: true,
                user_id: targetUser.id,
                email: targetUser.email,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("[lookup-user] Error:", error);
        return new Response(
            JSON.stringify({ error: "Internal error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
