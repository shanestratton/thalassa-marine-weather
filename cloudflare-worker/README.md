# thalassa-deepgram-proxy

Cloudflare Worker that bridges the iOS voice-console WebSocket to
Deepgram's `/v1/listen` streaming endpoint.

## Why this exists

iOS WKWebView refuses direct WebSocket connections to api.deepgram.com
(any subprotocol auth shape fails the upgrade with code=1006). The
natural fallback — proxying through a Supabase Edge Function — works
from desktop but dies after ~1 second under iOS-paced audio load
because Deno Deploy's runtime can't sustain the bridged WebSocket.

Cloudflare Workers' `WebSocketPair` API was designed for exactly this:
high-frequency message bridging without the execution-context tear-down
that bites Deno serverless. The proxy stays stable for the full
session.

## One-time setup

```bash
cd cloudflare-worker
npm install
npx wrangler login
```

## Set the secrets

```bash
npx wrangler secret put DEEPGRAM_API_KEY
# paste the long-lived 40-char key from
# https://console.deepgram.com/project/<id>/api-keys

npx wrangler secret put SUPABASE_ANON_KEY
# paste the same VITE_SUPABASE_KEY value used by the iOS bundle
# (find it in /Users/.../thalassa-marine-weather/.env.local)
```

## Deploy

```bash
npx wrangler deploy
```

The first deploy prints the live URL, e.g.:

```
Deployed thalassa-deepgram-proxy
https://thalassa-deepgram-proxy.<account-subdomain>.workers.dev
```

## Wire the iOS client

Add to `/Users/.../thalassa-marine-weather/.env.local`:

```
VITE_DEEPGRAM_PROXY_URL=https://thalassa-deepgram-proxy.<account-subdomain>.workers.dev
```

Then rebuild the iOS bundle (`npm run build && npx cap copy ios`) and
Cmd+R in Xcode. The voice console will route streaming STT through the
Worker.

## Watch live logs

```bash
npx wrangler tail
```

Useful when debugging — shows bridged chunk counts, message previews,
upstream close codes/reasons in real time.

## Cost

Workers free tier covers 100,000 requests/day with unmetered bandwidth.
Each iOS voice session is one request (the WebSocket lifetime). Should
be plenty for personal use; bump to Workers Paid ($5/month) at scale.
