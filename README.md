# Proximity Intercom

A PWA (installable on Android, runs as a web app on iOS) that connects everyone
within ~150m into a shared, always-on voice channel — like a professional intercom.

- **Voice:** WebRTC via [LiveKit](https://livekit.io) (SFU) — low latency, scales to many people.
- **Proximity (true 100m radius):** everyone in a coarse ~5km area joins one LiveKit
  room with auto-subscribe **off**. Each phone broadcasts its live GPS over the data
  channel, and each phone subscribes to the audio of **only the people within a true
  100m (haversine) distance** of itself — recomputed continuously as people move. Your
  bubble is centered on you (no fixed grid), so there's no boundary artifact.
- **Talk mode:** always-on open mic (no push-to-talk button).
- **PWA:** web manifest + service worker → "Install app" on Android, "Add to Home
  Screen" on iOS.

## Setup

You need a LiveKit server. Two options:

- **Free forever, unlimited (recommended for a riding group):** self-host LiveKit on a
  free cloud VM. Full step-by-step in [`deploy/SELF-HOSTING.md`](deploy/SELF-HOSTING.md).
  Includes the TURN relay riders need on cellular.
- **Zero setup:** a free [LiveKit Cloud](https://cloud.livekit.io) project. Genuinely $0
  but the free tier caps at ~5,000 connection-minutes/month (~14 hrs of 6-person talk),
  after which connections block until the next month.

Either way, put the key, secret, and `wss://` URL in `.env.local`:

```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
NEXT_PUBLIC_LIVEKIT_URL=wss://your-server
```

Then install and run:

```
npm install
npm run icons     # one-time: generate PWA icons
npm run dev
```

## Testing on phones

- Mic + geolocation require **HTTPS**. `localhost` works for one device; for real
  multi-phone testing either deploy (below) or expose the dev server over HTTPS
  (e.g. `ngrok http 3000`).
- Open the URL on two phones that are physically near each other → both land in the
  same channel and hear each other.

## Deploy (Vercel)

```
npx vercel
```

Add `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `NEXT_PUBLIC_LIVEKIT_URL` in the
Vercel project's Environment Variables, then redeploy. Vercel serves over HTTPS, so
mic/geolocation/PWA install all work out of the box.

## How proximity works (and its limits)

The web cannot do true Bluetooth/radio peer discovery (iOS Safari has no Web
Bluetooth), so "nearby" is computed from GPS. Matching is **true per-person radius**
(see above) — no grid boundary. Two remaining notes:

- **Area room:** the coarse ~5km room that bounds SFU scale still has an edge — two
  people very close but across a ~5km boundary won't connect. Rare in practice; for a
  riding group it effectively never happens. Eliminating it entirely needs a global
  presence server (out of scope).
- **Accuracy:** GPS is ~5–20m outdoors, worse indoors. Good for a ~100m bubble; not for
  sub-10m precision.

## Project structure

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Intercom UI + LiveKit/geolocation client logic |
| `app/api/token/route.ts` | Mints LiveKit access tokens (server-only secrets) |
| `lib/geohash.ts` | GPS → coarse area-room encoder |
| `lib/distance.ts` | Haversine distance for the true 100m radius check |
| `deploy/SELF-HOSTING.md` | Free-forever self-host guide (Oracle + DuckDNS + LiveKit) |
| `public/manifest.webmanifest`, `public/sw.js` | PWA install + offline shell |
| `scripts/generate-icons.mjs` | Generates PWA PNG icons |
