/**
 * send-anchor-alarm — Supabase Edge Function
 * 
 * Triggered when a row is inserted into `anchor_alarm_events`.
 * Looks up device tokens for the session and sends APNs Critical Alert
 * push notifications to shore devices.
 * 
 * Required Secrets (set via Supabase Dashboard → Edge Functions → Secrets):
 * - APNS_KEY_P8: The contents of your Apple .p8 auth key file
 * - APNS_KEY_ID: The Key ID from Apple Developer
 * - APNS_TEAM_ID: Your Apple Developer Team ID
 * - APNS_BUNDLE_ID: Your app's bundle identifier (e.g., com.thalassa.marine)
 * - SUPABASE_URL: Auto-provided
 * - SUPABASE_SERVICE_ROLE_KEY: Auto-provided
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64url } from "https://deno.land/std@0.177.0/encoding/base64url.ts";

// ---------- APNs JWT SIGNING ----------

async function createApnsJwt(): Promise<string> {
    const keyId = Deno.env.get("APNS_KEY_ID")!;
    const teamId = Deno.env.get("APNS_TEAM_ID")!;
    const p8Key = Deno.env.get("APNS_KEY_P8")!;

    // Parse PEM to raw key
    const pemBody = p8Key
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(/\s/g, "");
    const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
        "pkcs8",
        keyData,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );

    // JWT header + claims
    const header = { alg: "ES256", kid: keyId };
    const claims = {
        iss: teamId,
        iat: Math.floor(Date.now() / 1000),
    };

    const encoder = new TextEncoder();
    const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
    const claimsB64 = base64url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${claimsB64}`;

    // Sign with ES256
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        encoder.encode(signingInput)
    );

    // Convert DER signature to raw r || s format for JWT
    const sigB64 = base64url(new Uint8Array(signature));

    return `${signingInput}.${sigB64}`;
}

// ---------- SEND PUSH ----------

async function sendApnsPush(
    deviceToken: string,
    title: string,
    body: string,
    data: Record<string, unknown>
): Promise<boolean> {
    const bundleId = Deno.env.get("APNS_BUNDLE_ID") || "com.thalassa.marine";
    const jwt = await createApnsJwt();

    // Use production APNs (switch to api.sandbox.push.apple.com for dev)
    const useProduction = Deno.env.get("APNS_PRODUCTION") !== "false";
    const host = useProduction
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";

    const payload = {
        aps: {
            alert: { title, body },
            // Critical Alert — bypasses Do Not Disturb and silent mode
            sound: {
                critical: 1,
                name: "default",
                volume: 1.0,
            },
            "interruption-level": "critical",
            "content-available": 1,
            badge: 1,
        },
        ...data,
    };

    try {
        const response = await fetch(`${host}/3/device/${deviceToken}`, {
            method: "POST",
            headers: {
                authorization: `bearer ${jwt}`,
                "apns-topic": bundleId,
                "apns-push-type": "alert",
                "apns-priority": "10",
                "apns-expiration": "0",
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            return true;
        } else {
            const errorBody = await response.text();
            return false;
        }
    } catch (error) {
        return false;
    }
}

// ---------- MAIN HANDLER ----------

serve(async (req: Request) => {
    try {
        const { record } = await req.json();

        if (!record?.session_code) {
            return new Response(JSON.stringify({ error: "Missing session_code" }), {
                status: 400,
            });
        }

        const { session_code, distance_m, swing_radius_m, vessel_lat, vessel_lon } = record;


        // Look up device tokens for this session
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { data: tokens, error } = await supabase
            .from("anchor_alarm_tokens")
            .select("device_token, platform")
            .eq("session_code", session_code);

        if (error) {
            return new Response(JSON.stringify({ error: "Token lookup failed" }), {
                status: 500,
            });
        }

        if (!tokens || tokens.length === 0) {
            return new Response(JSON.stringify({ sent: 0, message: "No tokens" }), {
                status: 200,
            });
        }

        // Send push to all registered shore devices
        const distanceStr = Math.round(distance_m);
        const radiusStr = Math.round(swing_radius_m);
        const title = "⚓ ANCHOR DRAG ALARM";
        const body = `Your vessel has drifted ${distanceStr}m from anchor (${radiusStr}m swing radius). Check immediately!`;

        const results = await Promise.all(
            tokens.map((t: { device_token: string }) =>
                sendApnsPush(t.device_token, title, body, {
                    alarm_type: "anchor_drag",
                    session_code,
                    distance_m,
                    swing_radius_m,
                    vessel_lat,
                    vessel_lon,
                })
            )
        );

        const sent = results.filter(Boolean).length;

        return new Response(
            JSON.stringify({ sent, total: tokens.length }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
        });
    }
});
