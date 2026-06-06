"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  ConnectionState,
} from "livekit-client";
import { encodeGeohash } from "@/lib/geohash";
import { distanceMeters } from "@/lib/distance";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL || "";
const AREA_PRECISION = 5; // ~4.9km coarse area room
const RADIUS_M = 100; // true per-person intercom radius
const BROADCAST_MS = 2500;
const RECONNECT_DELAYS_MS = [1500, 3000, 6000, 12000, 25000, 30000];

type AppMode = "roomcode" | "proximity";
type Status = "idle" | "starting" | "live" | "error" | "reconnecting";

type Member = {
  identity: string;
  name: string;
  speaking: boolean;
  distance: number; // -1 in room code mode
};

type LatLng = { lat: number; lng: number; ts: number };

type WakeLockHandle = { release: () => Promise<void>; addEventListener: (type: string, cb: () => void) => void };

function getOrCreateIdentity(): { id: string; name: string } {
  if (typeof window === "undefined") return { id: "", name: "" };
  let id = localStorage.getItem("intercom_id");
  let name = localStorage.getItem("intercom_name") || "";
  if (!id) {
    id = "u_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("intercom_id", id);
  }
  if (!name) {
    name = "Rider " + id.slice(2, 6).toUpperCase();
    localStorage.setItem("intercom_name", name);
  }
  return { id, name };
}

function generateRoomCode(): string {
  // 6 chars; exclude 0/o and 1/l/i to avoid read-back confusion
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [areaOthers, setAreaOthers] = useState(0);
  const [muted, setMuted] = useState(false);
  const [name, setName] = useState("");
  const [meSpeaking, setMeSpeaking] = useState(false);
  const [appMode, setAppMode] = useState<AppMode>("roomcode");
  const [roomCode, setRoomCode] = useState(""); // stored lowercase
  const [displayCode, setDisplayCode] = useState(""); // uppercase, shown while live
  const [pttMode, setPttMode] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  const [copied, setCopied] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const areaRef = useRef("");
  const myPosRef = useRef<LatLng | null>(null);
  const locationsRef = useRef<Map<string, LatLng>>(new Map());
  const broadcastTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const identityRef = useRef<{ id: string; name: string }>({ id: "", name: "" });
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const currentRoomNameRef = useRef<string>("");

  // Mutable refs to escape stale-closure issues in async callbacks
  const statusRef = useRef<Status>("idle");
  const mutedRef = useRef(false);
  const pttModeRef = useRef(false);
  // connectToRoom is assigned after definition via a ref so wireRoomEvents can call it
  // without a circular dependency in the useCallback dep array.
  const connectToRoomRef = useRef<((roomName: string) => Promise<void>) | undefined>(undefined);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { pttModeRef.current = pttMode; }, [pttMode]);

  useEffect(() => {
    identityRef.current = getOrCreateIdentity();
    setName(identityRef.current.name);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

    // Honour ?room=CODE in URL so riders can share a link
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get("room");
    if (urlRoom) {
      const normalized = urlRoom.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
      if (normalized.length >= 4) {
        setAppMode("roomcode");
        setRoomCode(normalized);
        return;
      }
    }
    setRoomCode(generateRoomCode());
  }, []);

  // ── Wake lock ──────────────────────────────────────────────────────────────

  const acquireWakeLock = useCallback(async () => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<WakeLockHandle> } };
    if (!nav.wakeLock) return;
    try {
      const lock = await nav.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        // Re-acquire if still riding
        if (statusRef.current === "live" || statusRef.current === "reconnecting") {
          acquireWakeLock();
        }
      });
      wakeLockRef.current = lock;
    } catch { /* not available in all browsers */ }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // ── Audio ──────────────────────────────────────────────────────────────────

  const attachTrack = useCallback((track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.autoplay = true;
    (el as HTMLAudioElement).play?.().catch(() => {});
    audioContainerRef.current?.appendChild(el);
  }, []);

  // ── Proximity / subscription logic ────────────────────────────────────────

  const recompute = useCallback(() => {
    const room = roomRef.current;
    const me = myPosRef.current;
    if (!room) return;

    const isProximity = currentRoomNameRef.current.startsWith("geo_");
    const inRange: Member[] = [];
    let others = 0;

    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      if (isProximity) {
        const loc = locationsRef.current.get(p.identity);
        const dist = me && loc ? distanceMeters(me.lat, me.lng, loc.lat, loc.lng) : Infinity;
        const within = dist <= RADIUS_M;

        p.audioTrackPublications.forEach((pub: RemoteTrackPublication) => {
          if (pub.isSubscribed !== within) pub.setSubscribed(within);
        });

        if (within) {
          inRange.push({ identity: p.identity, name: p.name || p.identity, speaking: p.isSpeaking, distance: dist });
        } else if (loc) {
          others++;
        }
      } else {
        // Room-code mode: subscribe to everyone in the room
        p.audioTrackPublications.forEach((pub: RemoteTrackPublication) => {
          if (!pub.isSubscribed) pub.setSubscribed(true);
        });
        inRange.push({ identity: p.identity, name: p.name || p.identity, speaking: p.isSpeaking, distance: -1 });
      }
    });

    if (isProximity) inRange.sort((a, b) => a.distance - b.distance);
    setMembers(inRange);
    setAreaOthers(isProximity ? others : 0);
    setMeSpeaking(room.localParticipant.isSpeaking);
  }, []);

  const broadcastLocation = useCallback(() => {
    const room = roomRef.current;
    const me = myPosRef.current;
    if (!room || !me || room.state !== ConnectionState.Connected) return;
    if (!currentRoomNameRef.current.startsWith("geo_")) return;
    const payload = new TextEncoder().encode(JSON.stringify({ t: "loc", lat: me.lat, lng: me.lng }));
    room.localParticipant.publishData(payload, { reliable: true }).catch(() => {});
  }, []);

  // ── Reconnect ──────────────────────────────────────────────────────────────

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttemptsRef.current, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttemptsRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      if (statusRef.current === "reconnecting" && currentRoomNameRef.current) {
        connectToRoomRef.current?.(currentRoomNameRef.current);
      }
    }, delay);
  }, []);

  // ── Room lifecycle ─────────────────────────────────────────────────────────

  const wireRoomEvents = useCallback(
    (room: Room) => {
      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => attachTrack(track))
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
        })
        .on(RoomEvent.TrackPublished, () => recompute())
        .on(RoomEvent.ParticipantConnected, () => {
          broadcastLocation();
          recompute();
        })
        .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
          locationsRef.current.delete(p.identity);
          recompute();
        })
        .on(RoomEvent.ActiveSpeakersChanged, () => recompute())
        .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
          if (!participant) return;
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            if (msg.t === "loc" && typeof msg.lat === "number") {
              locationsRef.current.set(participant.identity, { lat: msg.lat, lng: msg.lng, ts: Date.now() });
              recompute();
            }
          } catch { /* ignore malformed data */ }
        })
        .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
          if (s === ConnectionState.Connected) {
            setStatus("live");
            broadcastLocation();
            recompute();
            reconnectAttemptsRef.current = 0;
          } else if (s === ConnectionState.Disconnected) {
            const cur = statusRef.current;
            if (cur === "live" || cur === "reconnecting") {
              setStatus("reconnecting");
              scheduleReconnect();
            }
          }
        });
    },
    [attachTrack, broadcastLocation, recompute, scheduleReconnect]
  );

  const connectToRoom = useCallback(
    async (roomName: string) => {
      // Cancel any pending reconnect timer; this call IS the reconnect
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (roomRef.current) {
        await roomRef.current.disconnect();
        roomRef.current = null;
      }

      const { id, name: displayName } = identityRef.current;
      let token: string;
      try {
        const res = await fetch(
          `/api/token?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(id)}&name=${encodeURIComponent(displayName)}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Could not get access token");
        }
        ({ token } = await res.json());
      } catch (e: unknown) {
        // If we're in a reconnect loop, retry; otherwise re-throw for goLive to handle
        if (statusRef.current === "reconnecting") {
          scheduleReconnect();
          return;
        }
        throw e;
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      wireRoomEvents(room);

      const isProximity = roomName.startsWith("geo_");
      // Room-code mode: let LiveKit auto-subscribe; proximity mode: manual based on distance
      await room.connect(LIVEKIT_URL, token, { autoSubscribe: !isProximity });

      // PTT mode starts muted; open-mic mode respects current mute state
      const micEnabled = pttModeRef.current ? false : !mutedRef.current;
      await room.localParticipant.setMicrophoneEnabled(micEnabled);

      roomRef.current = room;
      currentRoomNameRef.current = roomName;
      broadcastLocation();
      recompute();
    },
    [broadcastLocation, recompute, scheduleReconnect, wireRoomEvents]
  );

  // Keep the ref in sync so wireRoomEvents can call it without circular deps
  useEffect(() => { connectToRoomRef.current = connectToRoom; }, [connectToRoom]);

  const handlePosition = useCallback(
    (pos: GeolocationPosition) => {
      myPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };

      const coarse = "geo_" + encodeGeohash(pos.coords.latitude, pos.coords.longitude, AREA_PRECISION);
      if (coarse !== areaRef.current) {
        areaRef.current = coarse;
        connectToRoom(coarse).catch((e: Error) => {
          setError(e.message || String(e));
          setStatus("error");
        });
      } else {
        broadcastLocation();
        recompute();
      }
    },
    [broadcastLocation, connectToRoom, recompute]
  );

  // ── User actions ───────────────────────────────────────────────────────────

  const goLive = useCallback(async () => {
    setError("");
    if (!LIVEKIT_URL) {
      setError("NEXT_PUBLIC_LIVEKIT_URL is not configured. See .env.local.example.");
      setStatus("error");
      return;
    }
    setStatus("starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setError("Microphone permission is required.");
      setStatus("error");
      return;
    }

    if (appMode === "roomcode") {
      if (!roomCode || roomCode.length < 4) {
        setError("Enter a ride code (4–12 characters).");
        setStatus("error");
        return;
      }
      const rn = "ride_" + roomCode;
      const upper = roomCode.toUpperCase();
      currentRoomNameRef.current = rn;
      setDisplayCode(upper);

      // Embed code in URL so this tab's link becomes shareable
      const url = new URL(window.location.href);
      url.searchParams.set("room", upper);
      window.history.replaceState({}, "", url.toString());

      try {
        await connectToRoom(rn);
        await acquireWakeLock();
      } catch (e: unknown) {
        setError((e as Error).message || String(e));
        setStatus("error");
      }
    } else {
      // Proximity mode — needs GPS
      if (!("geolocation" in navigator)) {
        setError("This device has no geolocation support.");
        setStatus("error");
        return;
      }

      watchIdRef.current = navigator.geolocation.watchPosition(
        handlePosition,
        (err) => {
          setError(
            err.code === err.PERMISSION_DENIED
              ? "Location permission is required to find people near you."
              : "Could not get your location."
          );
          setStatus("error");
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );

      if (broadcastTimerRef.current) clearInterval(broadcastTimerRef.current);
      broadcastTimerRef.current = setInterval(broadcastLocation, BROADCAST_MS);
      await acquireWakeLock();
    }
  }, [acquireWakeLock, appMode, broadcastLocation, connectToRoom, handlePosition, roomCode]);

  const leave = useCallback(async () => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (watchIdRef.current !== null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
    if (broadcastTimerRef.current) { clearInterval(broadcastTimerRef.current); broadcastTimerRef.current = null; }
    if (roomRef.current) { await roomRef.current.disconnect(); roomRef.current = null; }
    releaseWakeLock();
    areaRef.current = "";
    myPosRef.current = null;
    locationsRef.current.clear();
    currentRoomNameRef.current = "";
    reconnectAttemptsRef.current = 0;
    setMembers([]);
    setAreaOthers(0);
    setStatus("idle");
    setMuted(false);
    setPttActive(false);
    setDisplayCode("");

    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url.toString());
  }, [releaseWakeLock]);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (roomRef.current) await roomRef.current.localParticipant.setMicrophoneEnabled(!next);
  }, [muted]);

  const startPtt = useCallback(async () => {
    setPttActive(true);
    if (roomRef.current) await roomRef.current.localParticipant.setMicrophoneEnabled(true);
  }, []);

  const stopPtt = useCallback(async () => {
    setPttActive(false);
    if (roomRef.current) await roomRef.current.localParticipant.setMicrophoneEnabled(false);
  }, []);

  const copyShareLink = useCallback(async () => {
    const code = displayCode || roomCode.toUpperCase();
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    url.hash = "";
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard not available */ }
  }, [displayCode, roomCode]);

  const saveName = useCallback((value: string) => {
    setName(value);
    identityRef.current.name = value;
    localStorage.setItem("intercom_name", value);
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (broadcastTimerRef.current) clearInterval(broadcastTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      roomRef.current?.disconnect();
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  // ── Derived display helpers ────────────────────────────────────────────────

  const isProximityMode = currentRoomNameRef.current.startsWith("geo_");
  const isLiveOrReconnecting = status === "live" || status === "reconnecting";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="wrap">
      <div className="card">
        <header className="head">
          <div className="logo">
            <span className="dot" data-status={status} />
            Rider Intercom
          </div>
          {(status === "idle" || status === "error") && (
            <a href="/download" className="downloadLink">
              Download App
            </a>
          )}
          {status === "live" && (
            <span className="chan">
              {isProximityMode ? `${RADIUS_M}m radius` : displayCode}
            </span>
          )}
          {status === "reconnecting" && (
            <span className="chan blink">Reconnecting…</span>
          )}
        </header>

        {/* ── Idle / Error screen ── */}
        {(status === "idle" || status === "error") && (
          <section className="hero">
            <div className="modeSwitch">
              <button
                className={appMode === "roomcode" ? "modeBtn active" : "modeBtn"}
                onClick={() => setAppMode("roomcode")}
              >
                Ride Code
              </button>
              <button
                className={appMode === "proximity" ? "modeBtn active" : "modeBtn"}
                onClick={() => setAppMode("proximity")}
              >
                Proximity
              </button>
            </div>

            {appMode === "roomcode" ? (
              <>
                <p className="lead">Share a code with your group. Anyone with it joins the same channel.</p>
                <label className="field">
                  <span>Ride code</span>
                  <div className="codeRow">
                    <input
                      className="codeInput"
                      value={roomCode.toUpperCase()}
                      onChange={(e) =>
                        setRoomCode(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12))
                      }
                      placeholder="e.g. RIDE42"
                      maxLength={12}
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button
                      className="regenBtn"
                      onClick={() => setRoomCode(generateRoomCode())}
                      title="Generate new code"
                      aria-label="Generate new code"
                    >
                      ↺
                    </button>
                    <button
                      className="shareIdleBtn"
                      onClick={copyShareLink}
                      title="Copy invite link"
                      aria-label="Copy invite link"
                    >
                      {copied ? "✓" : "⎘"}
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <p className="lead">
                Hear everyone within {RADIUS_M}m. Move in range — you're connected. Requires GPS + microphone.
              </p>
            )}

            <label className="field">
              <span>Your rider name</span>
              <input
                value={name}
                onChange={(e) => saveName(e.target.value)}
                placeholder="Rider name"
                maxLength={24}
              />
            </label>

            <label className="pttRow">
              <input
                type="checkbox"
                checked={pttMode}
                onChange={(e) => setPttMode(e.target.checked)}
              />
              <span className="pttLabel">Push-to-talk mode <span className="pttHint">(hold button to transmit)</span></span>
            </label>

            {status === "error" && <p className="err">{error}</p>}

            <button className="primary" onClick={goLive}>
              Go Live
            </button>
            <p className="fine">
              {appMode === "roomcode"
                ? "Needs microphone permission."
                : "Needs microphone + location permission."}
            </p>
          </section>
        )}

        {/* ── Starting screen ── */}
        {status === "starting" && (
          <section className="hero">
            <div className="spinner" />
            <p className="lead">
              {appMode === "roomcode" ? "Joining ride…" : "Locating you…"}
            </p>
          </section>
        )}

        {/* ── Live / Reconnecting screen ── */}
        {isLiveOrReconnecting && (
          <section className="live">
            <div className="meTile" data-speaking={meSpeaking && (pttMode ? pttActive : !muted)}>
              <div className="ring" />
              <div className="meName">{name || "You"}</div>
              <div className="meState">
                {status === "reconnecting"
                  ? "Reconnecting…"
                  : pttMode
                  ? pttActive
                    ? "Transmitting"
                    : "PTT ready"
                  : muted
                  ? "Muted"
                  : "Live"}
              </div>
            </div>

            <div className="peopleHead">
              {status === "reconnecting"
                ? "Signal lost — reconnecting…"
                : members.length === 0
                ? isProximityMode
                  ? `No one within ${RADIUS_M}m yet`
                  : "Waiting for other riders…"
                : `${members.length} rider${members.length === 1 ? "" : "s"} connected`}
              {areaOthers > 0 && (
                <span className="areaHint"> · {areaOthers} nearby out of range</span>
              )}
            </div>

            <ul className="people">
              {members.map((m) => (
                <li key={m.identity} data-speaking={m.speaking}>
                  <span className="av">{m.name.slice(0, 1).toUpperCase()}</span>
                  <span className="nm">{m.name}</span>
                  {m.distance >= 0 && <span className="dist">{Math.round(m.distance)}m</span>}
                  <span className="wave">{m.speaking ? "●" : ""}</span>
                </li>
              ))}
            </ul>

            {pttMode && (
              <button
                className={pttActive ? "pttBtn active" : "pttBtn"}
                onPointerDown={startPtt}
                onPointerUp={stopPtt}
                onPointerLeave={stopPtt}
                onPointerCancel={stopPtt}
              >
                {pttActive ? "● TRANSMITTING" : "HOLD TO TALK"}
              </button>
            )}

            <div className="controls">
              {!pttMode && (
                <button className={muted ? "ctl muted" : "ctl"} onClick={toggleMute}>
                  {muted ? "Unmute" : "Mute"}
                </button>
              )}
              {!isProximityMode && (
                <button className="ctl share" onClick={copyShareLink}>
                  {copied ? "Copied!" : "Share"}
                </button>
              )}
              <button className="ctl leave" onClick={leave}>
                Leave
              </button>
            </div>
          </section>
        )}
      </div>

      <div ref={audioContainerRef} style={{ display: "none" }} />
    </main>
  );
}
