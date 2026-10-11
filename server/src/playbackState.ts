import type { PlaybackState } from "./roomStore";

export type PlaybackSnapshot = PlaybackState;
export type PlaybackCommand = { action: "play" | "pause" | "restart" } | { action: "seek"; position: number };

export function playbackSnapshot(state: PlaybackState, now = Date.now()): PlaybackSnapshot {
  return {
    ...state,
    position: state.playing ? state.position + Math.max(0, now - state.serverTimestamp) / 1000 : state.position,
    serverTimestamp: now,
  };
}

export function applyPlaybackCommand(state: PlaybackState, command: PlaybackCommand, now = Date.now()): PlaybackSnapshot {
  const current = playbackSnapshot(state, now);
  const next: PlaybackState = {
    playing: command.action === "play" || command.action === "restart" ? true : command.action === "pause" ? false : current.playing,
    position: command.action === "restart" ? 0 : command.action === "seek" ? command.position : current.position,
    serverTimestamp: now,
    sequence: state.sequence + 1,
  };
  Object.assign(state, next);
  return { ...next };
}
