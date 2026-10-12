import cors from "cors";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { MovieServiceError, normalizeMovieDetails, tmdbMovieService, type MovieService } from "./movieService";
import { applyPlaybackCommand, playbackSnapshot } from "./playbackState";
import { addParticipant, createRoom, getRoom, normalizeCode, publicRoom, removeParticipant } from "./roomStore";

const searchMoviesSchema = z.object({
  query: z.string().trim().max(100).optional().default(""),
  genreId: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(1870).max(new Date().getFullYear() + 5).optional(),
  sortBy: z.enum(["popularity.desc", "vote_average.desc", "primary_release_date.desc", "primary_release_date.asc"]).default("popularity.desc"),
  page: z.coerce.number().int().min(1).max(500).default(1),
}).strict();

function sendMovieApiError(res: express.Response, error: unknown) {
  if (error instanceof MovieServiceError) return res.status(error.statusCode).json({ error: error.message });
  return res.status(502).json({ error: "The movie service could not complete the request. Please try again." });
}

export function createWatchPartyServer(options: { movieService?: MovieService } = {}) {
  const app = express();
  const httpServer: HttpServer = createServer(app);
  const movieService = options.movieService || tmdbMovieService;
  const allowedOrigin = process.env.WEB_ORIGIN || "http://localhost:3000";
  app.use(cors({ origin: allowedOrigin }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "watch-party-server" }));
  app.get("/api/movies/genres", async (_req, res) => {
    try { res.json({ genres: await movieService.getGenres() }); }
    catch (error) { sendMovieApiError(res, error); }
  });
  app.get("/api/movies/search", async (req, res) => {
    const parsed = searchMoviesSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Movie filters are invalid. Check the year, genre, sort, and page values." });
    try { res.json(await movieService.search(parsed.data)); }
    catch (error) { sendMovieApiError(res, error); }
  });
  app.get("/api/movies/:id", async (req, res) => {
    const parsed = z.string().regex(/^[1-9]\d{0,8}$/).transform(Number).safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "That movie ID is invalid." });
    try { res.json(normalizeMovieDetails(await movieService.getDetails(parsed.data))); }
    catch (error) { sendMovieApiError(res, error); }
  });

  const io = new Server(httpServer, {
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] },
    connectionStateRecovery: { maxDisconnectionDuration: 15_000, skipMiddlewares: true },
  });
  const pendingCleanup = new Map<string, ReturnType<typeof setTimeout>>();
  let shuttingDown = false;
  const input = z.object({ name: z.string().trim().min(2).max(30), code: z.string().trim().regex(/^[A-Za-z0-9]{6}$/).optional() });
  const playbackCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("play") }),
    z.object({ action: z.literal("pause") }),
    z.object({ action: z.literal("restart") }),
    z.object({ action: z.literal("seek"), position: z.number().finite().min(0).max(86_400) }),
  ]);
  const emitRoom = (code: string) => { const room = getRoom(code); if (room) io.to(code).emit("room:state", publicRoom(room)); };
  const emitPlayback = (code: string, snapshot?: ReturnType<typeof playbackSnapshot>, restarted = false) => {
    const room = getRoom(code);
    if (room) io.to(code).emit("playback:state", { ...(snapshot || playbackSnapshot(room.playback)), ...(restarted ? { restarted: true } : {}) });
  };
  const sendRoomSnapshot = (socket: Socket, code: string) => {
    const room = getRoom(code);
    if (!room) return;
    socket.emit("room:joined", publicRoom(room));
    socket.emit("playback:state", playbackSnapshot(room.playback));
  };
  function clearCleanup(id: string) {
    const timer = pendingCleanup.get(id);
    if (timer) clearTimeout(timer);
    pendingCleanup.delete(id);
  }
  function leaveCurrentRoom(socket: Socket) {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    clearCleanup(socket.id);
    const room = getRoom(code);
    if (room) {
      const newHost = removeParticipant(room, socket.id);
      socket.to(code).emit("room:notice", newHost ? `${newHost.name} is now the host.` : "A participant left the room.");
      socket.leave(code);
      emitRoom(code);
      emitPlayback(code);
    }
    delete socket.data.roomCode;
  }

  io.on("connection", socket => {
    clearCleanup(socket.id);
    if (socket.recovered && typeof socket.data.roomCode === "string") {
      const room = getRoom(socket.data.roomCode);
      const participant = room?.participants.get(socket.id);
      if (participant) participant.connected = true;
      if (room) emitRoom(room.code);
    }
    if (socket.recovered && typeof socket.data.roomCode === "string") sendRoomSnapshot(socket, socket.data.roomCode);

    socket.on("room:create", raw => {
      const parsed = input.pick({ name: true }).safeParse(raw);
      if (!parsed.success) return socket.emit("room:error", { message: "Choose a display name between 2 and 30 characters." });
      leaveCurrentRoom(socket);
      const { room } = createRoom(socket.id, parsed.data.name);
      socket.join(room.code); socket.data.roomCode = room.code;
      sendRoomSnapshot(socket, room.code); emitRoom(room.code);
    });
    socket.on("room:join", raw => {
      const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const parsedName = input.shape.name.safeParse(payload.name);
      if (!parsedName.success) return socket.emit("room:error", { message: "Enter a display name between 2 and 30 characters." });
      const parsedCode = z.string().trim().regex(/^[A-Za-z0-9]{6}$/).safeParse(payload.code);
      if (!parsedCode.success) return socket.emit("room:error", { message: "Enter a valid six-character room code." });
      const room = getRoom(normalizeCode(parsedCode.data));
      if (!room) return socket.emit("room:error", { message: "That room does not exist or has expired." });
      if (socket.data.roomCode === room.code) {
        sendRoomSnapshot(socket, room.code);
        return;
      }
      try {
        if (room.participants.size >= 10 && !room.participants.has(socket.id)) throw new Error("ROOM_FULL");
        leaveCurrentRoom(socket);
        addParticipant(room, socket.id, parsedName.data);
        socket.join(room.code); socket.data.roomCode = room.code;
        sendRoomSnapshot(socket, room.code); emitRoom(room.code);
      } catch (error) {
        socket.emit("room:error", { message: error instanceof Error && error.message === "ROOM_FULL" ? "This room is full (10 people maximum)." : "Unable to join this room." });
      }
    });
    socket.on("room:transfer-host", targetId => {
      const code = socket.data.roomCode as string | undefined; const room = code && getRoom(code);
      if (!room || room.hostId !== socket.id || typeof targetId !== "string" || !room.participants.has(targetId) || !room.participants.get(targetId)!.connected) {
        socket.emit("room:error", { message: "Only the current host can transfer host access to someone in this room." });
        return;
      }
      const previousHost = room.participants.get(socket.id)!;
      const nextHost = room.participants.get(targetId)!;
      previousHost.isHost = false; room.hostId = targetId; nextHost.isHost = true;
      socket.to(code).emit("room:notice", `${nextHost.name} is now the host.`);
      emitRoom(code);
    });
    socket.on("playback:command", raw => {
      const code = socket.data.roomCode as string | undefined; const room = code && getRoom(code);
      const command = playbackCommandSchema.safeParse(raw);
      if (!room || !room.participants.has(socket.id) || room.hostId !== socket.id) {
        socket.emit("playback:error", { message: "Only the current host can control playback." });
        if (code) sendRoomSnapshot(socket, code);
        return;
      }
      if (!command.success) {
        socket.emit("playback:error", { message: "That playback command is invalid." });
        emitPlayback(code);
        return;
      }
      const snapshot = applyPlaybackCommand(room.playback, command.data);
      emitPlayback(code, snapshot, command.data.action === "restart");
    });
    socket.on("movie:select", async raw => {
      const code = socket.data.roomCode as string | undefined;
      const room = code && getRoom(code);
      const payload = z.object({ movieId: z.number().int().positive().max(999_999_999) }).strict().safeParse(raw);
      if (!payload.success) {
        socket.emit("movie:error", { message: "That movie selection is invalid." });
        return;
      }
      if (!room || !room.participants.has(socket.id) || room.hostId !== socket.id) {
        socket.emit("movie:error", { message: "Only the current host can select a movie for this room." });
        return;
      }

      const version = ++room.movieSelectionVersion;
      try {
        const movie = normalizeMovieDetails(await movieService.getDetails(payload.data.movieId));
        const currentRoom = getRoom(code);
        if (!currentRoom || currentRoom !== room || currentRoom.hostId !== socket.id || !currentRoom.participants.has(socket.id)) {
          socket.emit("movie:error", { message: "Only the current host can select a movie for this room." });
          return;
        }
        if (currentRoom.movieSelectionVersion !== version) return;
        currentRoom.selectedMovie = movie;
        io.to(code).emit("movie:selected", movie);
        emitRoom(code);
      } catch (error) {
        if (getRoom(code) === room && room.movieSelectionVersion === version) {
          if (error instanceof MovieServiceError) socket.emit("movie:error", { message: error.message });
          else socket.emit("movie:error", { message: "Could not select that movie. Please try again." });
        }
      }
    });
    socket.on("room:leave", () => leaveCurrentRoom(socket));
    socket.on("disconnect", () => {
      if (shuttingDown) return;
      const code = socket.data.roomCode as string | undefined;
      if (!code) return;
      clearCleanup(socket.id);
      const room = getRoom(code);
      const participant = room?.participants.get(socket.id);
      if (participant) {
        participant.connected = false;
        io.to(code).emit("room:notice", `${participant.name} disconnected; waiting for them to reconnect.`);
        emitRoom(code);
      }
      const timer = setTimeout(() => {
        pendingCleanup.delete(socket.id);
        const room = getRoom(code);
        if (!room) return;
        const newHost = removeParticipant(room, socket.id);
        io.to(code).emit("room:notice", newHost ? `${newHost.name} is now the host.` : "A participant left the room.");
        emitRoom(code);
        emitPlayback(code);
        delete socket.data.roomCode;
      }, 15_000);
      pendingCleanup.set(socket.id, timer);
    });
  });

  return {
    app,
    httpServer,
    io,
    close: () => {
      shuttingDown = true;
      for (const timer of pendingCleanup.values()) clearTimeout(timer);
      pendingCleanup.clear();
      io.close();
    },
  };
}
