import { randomBytes } from "node:crypto";
import type { MovieDetails } from "./movieService";
import type { OpenFilm } from "./openFilms";

export type Participant = { id: string; name: string; isHost: boolean; connected: boolean };
export type PlaybackState = { playing: boolean; position: number; serverTimestamp: number; sequence: number };
export type Room = { code: string; hostId: string; participants: Map<string, Participant>; createdAt: number; playback: PlaybackState; selectedMovie: MovieDetails | null; selectedOpenFilm: OpenFilm | null; movieSelectionVersion: number };

const rooms = new Map<string, Room>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeCode(value: string) { return value.trim().toUpperCase(); }
export function createRoom(id: string, name: string): { room: Room; participant: Participant } {
  let code = "";
  do { code = Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join(""); } while (rooms.has(code));
  const participant = { id, name, isHost: true, connected: true };
  const now = Date.now();
  const room = { code, hostId: id, participants: new Map([[id, participant]]), createdAt: now, playback: { playing: false, position: 0, serverTimestamp: now, sequence: 0 }, selectedMovie: null, selectedOpenFilm: null, movieSelectionVersion: 0 };
  rooms.set(code, room);
  return { room, participant };
}
export function getRoom(code: string) { return rooms.get(normalizeCode(code)); }
export function deleteRoomIfEmpty(code: string) { const room = getRoom(code); if (room && room.participants.size === 0) rooms.delete(room.code); }
export function publicRoom(room: Room) { return { code: room.code, participants: [...room.participants.values()], limit: 10, selectedMovie: room.selectedMovie, selectedOpenFilm: room.selectedOpenFilm }; }
export function removeParticipant(room: Room, id: string) {
  const wasHost = room.hostId === id;
  room.participants.delete(id);
  let newHost: Participant | undefined;
  if (wasHost && room.participants.size) {
    newHost = room.participants.values().next().value as Participant;
    room.hostId = newHost.id;
    newHost.isHost = true;
  }
  deleteRoomIfEmpty(room.code);
  return newHost;
}
export function addParticipant(room: Room, id: string, name: string) {
  if (room.participants.size >= 10) throw new Error("ROOM_FULL");
  const existing = room.participants.get(id);
  if (existing) return existing;
  const participant = { id, name, isHost: false, connected: true };
  room.participants.set(id, participant);
  return participant;
}
