"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import Image from "next/image";
import MovieDiscovery, { type MovieDetails } from "./components/MovieDiscovery";

type Person = { id: string; name: string; isHost: boolean; connected: boolean };
type Room = { code: string; participants: Person[]; limit: number; selectedMovie: MovieDetails | null };
type Playback = { playing: boolean; position: number; serverTimestamp: number; sequence: number; receivedAt: number; restarted?: boolean };

const API = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";
const VIDEO_URL = process.env.NEXT_PUBLIC_SAMPLE_VIDEO_URL?.trim() || "/samples/flower.mp4";
const MOVIE_TITLE = "Flower sample";
const ATTRIBUTION_URL = "https://github.com/mdn/interactive-examples";
const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const DRIFT_SEEK_THRESHOLD = 1.5;
const DRIFT_RATE_THRESHOLD = 0.15;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playbackCommandPending, setPlaybackCommandPending] = useState(false);
  const [movieDiscoveryOpen, setMovieDiscoveryOpen] = useState(false);
  const [movieSelectionError, setMovieSelectionError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [needsPlaybackGesture, setNeedsPlaybackGesture] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<Playback | null>(null);
  const roomCodeRef = useRef("");
  const nameRef = useRef("");
  const hadDisconnectRef = useRef(false);
  const playbackCommandPendingRef = useRef(false);
  const playbackApplyGenerationRef = useRef(0);
  const cancelPlaybackSeekRef = useRef<(() => void) | null>(null);
  const synchronizingRef = useRef(false);

  const retryVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setMediaError("");
    setMediaReady(false);
    setCurrentTime(0);
    setDuration(0);
    video.load();
  }, []);

  useEffect(() => {
    const inviteCode = new URLSearchParams(window.location.search).get("room");
    if (inviteCode) setCode(inviteCode.toUpperCase().slice(0, 6));
    const s = io(API, { autoConnect: true, reconnection: true });
    s.on("connect", () => {
      setConnected(true);
      if (hadDisconnectRef.current) {
        setReconnecting(false);
        if (!s.recovered && roomCodeRef.current && nameRef.current) {
          s.emit("room:join", { name: nameRef.current, code: roomCodeRef.current });
        }
        hadDisconnectRef.current = false;
      }
    });
    s.on("disconnect", () => { setConnected(false); hadDisconnectRef.current = true; setReconnecting(Boolean(roomCodeRef.current)); });
    s.on("room:joined", (nextRoom: Room) => { roomCodeRef.current = nextRoom.code; setRoom(nextRoom); setError(""); setReconnecting(false); });
    s.on("room:state", setRoom);
    s.on("room:error", (event: { message: string }) => { setError(event.message); setReconnecting(false); });
    s.on("room:notice", (message: string) => setNotice(message));
    s.on("playback:state", (snapshot: Omit<Playback, "receivedAt">) => {
      const previous = playbackRef.current;
      if (previous && (snapshot.sequence < previous.sequence || (snapshot.sequence === previous.sequence && snapshot.serverTimestamp <= previous.serverTimestamp))) return;
      const received = { ...snapshot, receivedAt: performance.now() };
      playbackRef.current = received;
      if (playbackCommandPendingRef.current && (!previous || snapshot.sequence > previous.sequence)) {
        playbackCommandPendingRef.current = false;
        setPlaybackCommandPending(false);
      }
      setPlayback(received);
    });
    s.on("playback:error", (event: { message: string }) => {
      playbackCommandPendingRef.current = false;
      setPlaybackCommandPending(false);
      setError(event.message);
    });
    s.on("movie:selected", (movie: MovieDetails) => {
      setRoom(previous => previous ? { ...previous, selectedMovie: movie } : previous);
      setMovieSelectionError("");
    });
    s.on("movie:error", (event: { message: string }) => setMovieSelectionError(event.message));
    setSocket(s);
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => { nameRef.current = name.trim(); }, [name]);

  const me = useMemo(() => room?.participants.find(person => person.id === socket?.id), [room, socket]);
  const isHost = Boolean(me?.isHost);

  function requestMovieSelection(movieId: number) {
    if (!isHost) return;
    if (!connected) {
      setMovieSelectionError("Reconnect to the room before selecting a movie.");
      return;
    }
    setMovieSelectionError("");
    socket?.emit("movie:select", { movieId });
  }

  const applyAuthoritativePlayback = useCallback(async () => {
    const generation = ++playbackApplyGenerationRef.current;
    synchronizingRef.current = false;
    cancelPlaybackSeekRef.current?.();
    const video = videoRef.current;
    const snapshot = playbackRef.current;
    if (!video || !snapshot || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const elapsed = snapshot.playing ? Math.max(0, performance.now() - snapshot.receivedAt) / 1000 : 0;
    const target = Math.max(0, Math.min(snapshot.position + elapsed, Number.isFinite(video.duration) ? video.duration : snapshot.position + elapsed));
    const drift = target - video.currentTime;
    const mustSeek = snapshot.restarted || Math.abs(drift) > DRIFT_SEEK_THRESHOLD;
    if (mustSeek) {
      video.playbackRate = 1;
      if (snapshot.restarted && !video.paused) video.pause();
      if (Math.abs(drift) > 0.02) {
        synchronizingRef.current = true;
        try {
          await new Promise<void>((resolve, reject) => {
            let cancel = () => {};
            const cleanup = () => {
              video.removeEventListener("seeked", onSeeked);
              video.removeEventListener("error", onError);
              if (cancelPlaybackSeekRef.current === cancel) cancelPlaybackSeekRef.current = null;
            };
            const onSeeked = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error("Video seek failed")); };
            cancel = () => { cleanup(); resolve(); };
            cancelPlaybackSeekRef.current = cancel;
            video.addEventListener("seeked", onSeeked, { once: true });
            video.addEventListener("error", onError, { once: true });
            try {
              video.currentTime = target;
              if (!video.seeking) { cleanup(); resolve(); }
            } catch (error) {
              cleanup();
              reject(error);
            }
          });
        } catch {
          if (generation === playbackApplyGenerationRef.current) setError("Could not seek the video to the synchronized position.");
          return;
        } finally {
          if (generation === playbackApplyGenerationRef.current) synchronizingRef.current = false;
        }
        if (generation !== playbackApplyGenerationRef.current) return;
      }
    }
    if (!snapshot.playing) {
      video.playbackRate = 1;
      if (!video.paused) video.pause();
      setNeedsPlaybackGesture(false);
      return;
    }
    try {
      if (video.paused || video.ended) await video.play();
      if (generation === playbackApplyGenerationRef.current) setNeedsPlaybackGesture(false);
    } catch {
      if (generation === playbackApplyGenerationRef.current) setNeedsPlaybackGesture(true);
    }
    if (generation !== playbackApplyGenerationRef.current) return;
    const remainingDrift = target - video.currentTime;
    if (Math.abs(remainingDrift) > DRIFT_SEEK_THRESHOLD) video.playbackRate = 1;
    else if (Math.abs(remainingDrift) > DRIFT_RATE_THRESHOLD) video.playbackRate = remainingDrift > 0 ? 1.05 : 0.95;
    else video.playbackRate = 1;
  }, []);

  useEffect(() => { applyAuthoritativePlayback(); }, [playback, mediaReady, applyAuthoritativePlayback]);

  function submit(e: FormEvent, action: "create" | "join") {
    e.preventDefault(); setError("");
    const cleanName = name.trim();
    if (cleanName.length < 2 || cleanName.length > 30) return setError("Enter a display name between 2 and 30 characters.");
    if (action === "join" && !/^[A-Za-z0-9]{6}$/.test(code.trim())) return setError("Enter a valid six-character room code.");
    if (!socket?.connected) return setError("Connecting to the server… try again in a moment.");
    nameRef.current = cleanName;
    if (action === "create") socket.emit("room:create", { name: cleanName });
    else socket.emit("room:join", { name: cleanName, code: code.trim().toUpperCase() });
  }

  function sendPlaybackCommand(command: { action: "play" | "pause" | "restart" } | { action: "seek"; position: number }) {
    if (!isHost || !connected || !mediaReady || playbackCommandPendingRef.current) return;
    setError("");
    playbackCommandPendingRef.current = true;
    setPlaybackCommandPending(true);
    socket?.emit("playback:command", command);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (video && (video.ended || (duration > 0 && video.currentTime >= duration - 0.25))) {
      sendPlaybackCommand({ action: "restart" });
      return;
    }
    if (playback?.playing) {
      sendPlaybackCommand({ action: "pause" });
      return;
    }
    sendPlaybackCommand({ action: "play" });
  }

  function commitSeek(value: number) {
    if (!isHost || !connected) return;
    sendPlaybackCommand({ action: "seek", position: value });
    setSeekDraft(null);
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (synchronizingRef.current) return;
    const snapshot = playbackRef.current;
    if (!snapshot || !mediaReady || !connected) return;
    const target = snapshot.position + (snapshot.playing ? Math.max(0, performance.now() - snapshot.receivedAt) / 1000 : 0);
    const drift = target - video.currentTime;
    if (Math.abs(drift) > DRIFT_SEEK_THRESHOLD) {
      video.currentTime = target;
      video.playbackRate = 1;
    } else if (snapshot.playing && Math.abs(drift) > DRIFT_RATE_THRESHOLD) {
      video.playbackRate = drift > 0 ? 1.05 : 0.95;
    } else {
      video.playbackRate = 1;
    }
  }

  function handleVideoEnded() {
    const video = videoRef.current;
    const snapshot = playbackRef.current;
    if (!isHost || !video || !snapshot?.playing) return;
    if (snapshot.restarted && (!duration || video.currentTime < duration - 0.25)) return;
    sendPlaybackCommand({ action: "pause" });
  }

  async function copyInvite() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}?room=${room.code}`);
      setCopied(true); window.setTimeout(() => setCopied(false), 1800);
    } catch { setError("Could not copy the invite link. You can copy it from the address shown."); }
  }

  if (!room) return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <p className="mb-3 text-sm font-semibold tracking-widest text-cyan-300">WATCH PARTY</p>
        <h1 className="mb-3 text-4xl font-bold">Watch together, anywhere.</h1>
        <p className="mb-8 text-slate-400">Create a room and invite friends with a simple six-character code.</p>
        <form className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <label htmlFor="display-name" className="mb-2 block text-sm text-slate-300">Display name</label>
          <input id="display-name" required minLength={2} maxLength={30} value={name} onChange={event => setName(event.target.value)} className="mb-5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 outline-none focus:border-cyan-400" placeholder="e.g. Alex" />
          <button onClick={event => submit(event, "create")} className="mb-4 w-full rounded-lg bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300">Create room</button>
          <div className="my-5 flex items-center gap-3 text-xs text-slate-500"><span className="h-px flex-1 bg-slate-700" />OR<span className="h-px flex-1 bg-slate-700" /></div>
          <label htmlFor="room-code" className="mb-2 block text-sm text-slate-300">Room code</label>
          <div className="flex gap-2"><input id="room-code" value={code} onChange={event => setCode(event.target.value.toUpperCase().slice(0, 6))} maxLength={6} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 uppercase outline-none focus:border-cyan-400" placeholder="ABC123" /><button onClick={event => submit(event, "join")} className="rounded-lg border border-cyan-400 px-5 font-semibold text-cyan-300">Join</button></div>
          {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
          <p className="mt-5 text-xs text-slate-500">{connected ? "Server connected" : "Connecting…"}</p>
        </form>
      </div>
    </main>
  );

  const inviteUrl = typeof window !== "undefined" ? `${window.location.origin}?room=${room.code}` : "";
  const timelineValue = seekDraft ?? currentTime;
  return (
    <main className="min-h-screen bg-[#080d18] px-4 py-5 text-slate-100 sm:px-6 lg:h-dvh lg:overflow-hidden lg:px-8">
      <div className="mx-auto max-w-[1500px] lg:flex lg:h-full lg:flex-col">
        <header className="mb-5 flex items-center justify-between gap-4 lg:shrink-0">
          <div><p className="text-xs font-semibold tracking-[0.2em] text-cyan-300">WATCH PARTY</p><h1 className="mt-1 text-2xl font-bold sm:text-3xl">Room <span className="text-cyan-300">{room.code}</span></h1></div>
          <div className="flex items-center gap-3"><span className={`hidden text-sm sm:inline ${connected ? "text-emerald-300" : "text-amber-300"}`}>{reconnecting ? "Reconnecting…" : connected ? "Connected" : "Disconnected"}</span><button className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:border-slate-400" onClick={() => { roomCodeRef.current = ""; socket?.emit("room:leave"); setRoom(null); setPlayback(null); setError(""); }}>Leave</button></div>
        </header>

        <div className="grid items-start gap-5 lg:min-h-0 lg:flex-1 lg:items-stretch lg:grid-cols-[minmax(0,1fr)_310px] lg:grid-rows-1">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/30 lg:flex lg:min-h-0 lg:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-5"><div><h2 className="font-semibold">{MOVIE_TITLE} · demo video</h2><a className="text-xs text-slate-400 underline decoration-slate-600 underline-offset-2 hover:text-cyan-300" href={ATTRIBUTION_URL} target="_blank" rel="noreferrer">MDN sample video · CC0 1.0</a></div><span className="text-xs text-slate-500">{playback?.playing ? "Playing" : "Paused"}{playback ? ` · sync #${playback.sequence}` : ""}</span></div>

            <div className="relative aspect-video bg-black lg:min-h-0 lg:flex-1 lg:aspect-auto">
              <video ref={videoRef} src={VIDEO_URL} preload="metadata" playsInline className="h-full w-full object-contain" onLoadedMetadata={event => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setMediaReady(true); setMediaError(""); }} onCanPlay={() => { setMediaReady(true); setMediaError(""); }} onWaiting={() => setMediaReady(false)} onPlaying={() => setMediaReady(true)} onTimeUpdate={handleTimeUpdate} onEnded={handleVideoEnded} onError={() => { setMediaReady(false); setMediaError("The sample video could not be loaded. Check your connection or set NEXT_PUBLIC_SAMPLE_VIDEO_URL to a reachable MP4 or WebM file."); }} />
              {!mediaReady && !mediaError && <div className="absolute inset-0 flex items-center justify-center bg-black/55"><div className="flex items-center gap-3 text-sm text-slate-200"><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-300" />Loading video…</div></div>}
              {mediaError && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 p-6 text-center"><p role="alert" className="max-w-lg text-sm text-rose-200">{mediaError}</p><button type="button" onClick={retryVideo} className="rounded-lg border border-cyan-400 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-400/10">Retry video</button></div>}
              {needsPlaybackGesture && playback?.playing && !mediaError && <div className="absolute inset-0 flex items-center justify-center bg-black/55"><button onClick={() => { const video = videoRef.current; if (video) void video.play().then(() => setNeedsPlaybackGesture(false)).catch(() => setMediaError("Your browser blocked playback. Check the video source or browser media settings.")); }} className="rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950">Enable synced playback</button></div>}
              {!connected && <div className="absolute bottom-3 left-3 rounded-md bg-black/75 px-3 py-2 text-xs text-amber-200">Playback controls paused while reconnecting</div>}
            </div>

            <div className="space-y-3 px-4 py-4 sm:px-5 lg:shrink-0">
              <input aria-label="Playback timeline" type="range" min={0} max={duration || 0} step="0.1" value={Math.min(timelineValue, duration || timelineValue)} disabled={!isHost || !connected || !mediaReady || !duration} onChange={event => setSeekDraft(Number(event.target.value))} onPointerUp={event => commitSeek(Number(event.currentTarget.value))} onKeyUp={event => commitSeek(Number(event.currentTarget.value))} className="h-2 w-full cursor-pointer accent-cyan-400 disabled:cursor-not-allowed disabled:opacity-40" />
              <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><button aria-label={playback?.playing ? "Pause" : "Play"} disabled={!isHost || !connected || !mediaReady || playbackCommandPending} onClick={togglePlayback} className="grid h-10 w-10 place-items-center rounded-full bg-cyan-400 text-lg font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">{playback?.playing ? "Ⅱ" : "▶"}</button><span className="font-mono text-sm tabular-nums text-slate-300">{formatTime(timelineValue)} <span className="text-slate-600">/</span> {duration ? formatTime(duration) : "--:--"}</span></div><span className="text-xs text-slate-500">{isHost ? "You control playback" : "Only the host controls playback"}</span></div>
              {!connected && <p className="text-sm text-amber-300">Reconnecting to the room. Playback control is temporarily unavailable.</p>}
              {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
            </div>
          </section>

          <aside className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:p-5 lg:max-h-full lg:self-start lg:overflow-y-auto">
            <section aria-labelledby="selected-movie-heading" className="mb-5 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
              <div className="mb-3 flex items-center justify-between gap-3"><h2 id="selected-movie-heading" className="text-sm font-semibold">Selected movie</h2><span className="text-[10px] uppercase tracking-wide text-slate-500">Room-wide</span></div>
              {room.selectedMovie ? <div className="flex gap-3"><div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-800">{room.selectedMovie.posterPath ? <Image fill sizes="64px" src={`${TMDB_POSTER_BASE}${room.selectedMovie.posterPath}`} alt={`${room.selectedMovie.title} poster`} className="object-cover" /> : <div className="grid h-full place-items-center px-1 text-center text-[10px] text-slate-500">No poster</div>}</div><div className="min-w-0"><p className="line-clamp-2 font-semibold">{room.selectedMovie.title}</p><p className="mt-1 text-xs text-slate-400">{room.selectedMovie.releaseDate?.slice(0, 4) || "Release year unknown"} · ★ {room.selectedMovie.voteAverage.toFixed(1)}</p><p className="mt-2 line-clamp-3 text-xs leading-relaxed text-slate-500">{room.selectedMovie.overview || "No synopsis available."}</p></div></div> : <p className="text-xs text-slate-500">No movie selected yet.</p>}
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Movie information and posters do not include a playable stream. The demo video remains separate and unchanged.</p>
              <button type="button" onClick={() => { setMovieSelectionError(""); setMovieDiscoveryOpen(true); }} className="mt-3 w-full rounded-lg border border-cyan-700 px-3 py-2 text-sm font-semibold text-cyan-200 hover:border-cyan-400 hover:bg-cyan-950/40">Discover movies</button>
              {movieSelectionError && !movieDiscoveryOpen && <p role="alert" className="mt-2 text-xs text-rose-300">{movieSelectionError}</p>}
            </section>
            <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Participants</h2><span className="text-sm text-slate-400">{room.participants.length}/{room.limit}</span></div>
            <ul className="space-y-2">{room.participants.map(person => <li key={person.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-800/80 px-3 py-3"><span className="min-w-0 truncate text-sm">{person.name}{person.id === socket?.id && <span className="text-slate-400"> (you)</span>}{!person.connected && <span className="ml-1 text-xs text-amber-300">reconnecting</span>}</span><span className="shrink-0 text-xs">{person.isHost ? <span className="text-amber-300">Host</span> : isHost && person.connected ? <button className="text-cyan-300 hover:underline" onClick={() => { setError(""); socket?.emit("room:transfer-host", person.id); }}>Make host</button> : null}</span></li>)}</ul>
            {notice && <p role="status" className="mt-4 text-xs text-emerald-300">{notice}</p>}
            <div className="mt-5 border-t border-slate-800 pt-4"><p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">Invite friends</p><p className="break-all text-xs text-slate-500">{inviteUrl}</p><button onClick={() => void copyInvite()} className="mt-3 w-full rounded-lg border border-slate-600 px-3 py-2 text-sm hover:border-cyan-300">{copied ? "Copied invite link" : "Copy invite link"}</button><p className="mt-2 text-xs text-slate-500">Guests enter a name after opening the link.</p></div>
            <p className="mt-5 border-t border-slate-800 pt-4 text-xs leading-relaxed text-slate-500">Video synchronization works with this direct MP4/WebM player. Embedded third-party players such as YouTube manage their own playback state and restrictions, so they need a provider-specific integration and can’t be controlled reliably by this player.</p>
          </aside>
        </div>
      </div>
      <MovieDiscovery open={movieDiscoveryOpen} isHost={isHost} canSelect={connected} selectedMovie={room.selectedMovie} selectionError={movieSelectionError} onClose={() => setMovieDiscoveryOpen(false)} onSelect={requestMovieSelection} />
    </main>
  );
}
