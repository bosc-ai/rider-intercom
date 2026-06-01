import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

// Mints a short-lived LiveKit access token for a given proximity room + identity.
// The room name is derived client-side from the user's geohash bucket.
export async function GET(req: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "Server missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(req.url);
  const room = searchParams.get("room");
  const identity = searchParams.get("identity");
  const name = searchParams.get("name") || identity || "Guest";

  if (!room || !identity) {
    return NextResponse.json(
      { error: "room and identity are required" },
      { status: 400 }
    );
  }

  // Allow proximity rooms (geo_*) and explicit ride rooms (ride_*).
  if (!/^(geo_[0-9bcdefghjkmnpqrstuvwxyz]{4,12}|ride_[a-z0-9]{4,12})$/.test(room)) {
    return NextResponse.json({ error: "invalid room" }, { status: 400 });
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl: "1h",
  });

  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return NextResponse.json({ token });
}
