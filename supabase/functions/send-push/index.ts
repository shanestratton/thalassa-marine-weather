/**
 * send-push — Generalized Push Notification Edge Function
 * 
 * Triggered by database webhook on INSERT to `push_notification_queue`.
 * Reads the notification, looks up the recipient's device tokens,
 * and sends via APNs.
 * 
 * Supports notification types:
 * - dm: Direct message received
 * - sos: SOS question posted in channel
 * - anchor_alarm: Anchor drag detected (Critical Alert)
 * - pin_drop: Pin shared in channel
 * - track_shared: Voyage track shared
 * - weather_alert: Severe weather warning
 * 
 * Required Secrets (Supabase Dashboard → Edge Functions → Secrets):
 * - APNS_KEY_P8: Apple .p8 auth key contents
 * - APNS_KEY_ID: Key ID from Apple Developer
 * - APNS_TEAM_ID: Apple Developer Team ID
 * - APNS_BUNDLE_ID: App bundle identifier (e.g., com.thalassa.weather)
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

    const header = { alg: "ES256", kid: keyId };
    const claims = {
        iss: teamId,
        iat: Math.floor(Date.now() / 1000),
    };

    const encoder = new TextEncoder();
    const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
    const claimsB64 = base64url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${claimsB64}`;

    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        encoder.encode(signingInput)
    );

    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

// ---------- SEND PUSH ----------

interface PushPayload {
    title: string;
    body: string;
    data: Record<string, unknown>;
    isCritical?: boolean;
}

async function sendApnsPush(
    deviceToken: string,
    payload: PushPayload
): Promise<boolean> {
    const bundleId = Deno.env.get("APNS_BUNDLE_ID") || "com.thalassa.weather-2025";
    const jwt = await createApnsJwt();

    const useProduction = Deno.env.get("APNS_PRODUCTION") !== "false";
    const host = useProduction
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";

    // Build APNs payload
    const aps: Record<string, unknown> = {
        alert: { title: payload.title, body: payload.body },
        "content-available": 1,
        badge: 1,
    };

    if (payload.isCritical) {
        // Critical Alert — bypasses DND and silent mode (requires Apple entitlement)
        aps.sound = { critical: 1, name: "default", volume: 1.0 };
        aps["interruption-level"] = "critical";
    } else {
        aps.sound = "default";
        aps["interruption-level"] = "active";
    }

    const apnsPayload = { aps, ...payload.data };

    try {
        const response = await fetch(`${host}/3/device/${deviceToken}`, {
            method: "POST",
            headers: {
                authorization: `bearer ${jwt}`,
                "apns-topic": bundleId,
                "apns-push-type": "alert",
                "apns-priority": payload.isCritical ? "10" : "5",
                "apns-expiration": "0",
                "content-type": "application/json",
            },
            body: JSON.stringify(apnsPayload),
        });

        if (response.ok) {
            return true;
        } else {
            const errorBody = await response.text();
            console.error(`APNs error (${response.status}):`, errorBody);
            return false;
        }
    } catch (error) {
        console.error("APNs send error:", error);
        return false;
    }
}

// ---------- NOTIFICATION TYPE CONFIG ----------

function isCriticalType(type: string): boolean {
    return type === "anchor_alarm";
}

// ---------- MAIN HANDLER ----------

serve(async (req: Request) => {
    try {
        const { record } = await req.json();

        if (!record?.recipient_user_id || !record?.title || !record?.body) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const { id, recipient_user_id, notification_type, title, body, data } = record;

        // Look up device tokens for the recipient
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { data: tokens, error } = await supabase
            .from("push_device_tokens")
            .select("device_token, platform")
            .eq("user_id", recipient_user_id);

        if (error) {
            console.error("Token lookup failed:", error);
            return new Response(JSON.stringify({ error: "Token lookup failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (!tokens || tokens.length === 0) {
            // Mark as sent (no tokens to deliver to)
            await supabase
                .from("push_notification_queue")
                .update({ sent_at: new Date().toISOString() })
                .eq("id", id);

            return new Response(JSON.stringify({ sent: 0, message: "No registered devices" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        // Send push to all registered devices
        const results = await Promise.all(
            tokens.map((t: { device_token: string }) =>
                sendApnsPush(t.device_token, {
                    title,
                    body,
                    data: {
                        notification_type,
                        ...(data || {}),
                    },
                    isCritical: isCriticalType(notification_type),
                })
            )
        );

        const sent = results.filter(Boolean).length;

        // Mark notification as sent
        await supabase
            .from("push_notification_queue")
            .update({ sent_at: new Date().toISOString() })
            .eq("id", id);

        return new Response(
            JSON.stringify({ sent, total: tokens.length }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Edge function error:", error);
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
});
