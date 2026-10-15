import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { createWatchPartyServer } from "../src/watchPartyServer";
import { normalizeMovieDetails, type MovieDetails } from "../src/movieService";

const testMovie: MovieDetails = {
  id: 550,
  title: "Fight Club",
  overview: "A test synopsis.",
  posterPath: "/poster.jpg",
  releaseDate: "1999-10-15",
  voteAverage: 8.4,
  popularity: 12.5,
  genreIds: [],
  genres: [{ id: 18, name: "Drama" }],
};
const server = createWatchPartyServer({
  movieService: {
    async getGenres() { return [{ id: 18, name: "Drama" }]; },
    async search(params) { return { page: params.page, totalPages: 0, totalResults: 0, results: [] }; },
    async getDetails(id) {
      if (id === testMovie.id) return testMovie;
      if (id === 551) return { id: 551, title: "Optional arrays", overview: "", posterPath: null, releaseDate: "", voteAverage: 0, popularity: 0 } as unknown as MovieDetails;
      throw new Error("Unexpected test movie id");
    },
  },
});
let serverUrl = "";
const clients: ClientSocket[] = [];

function event<T>(socket: ClientSocket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, 3000);
    const listener = (value: T) => { clearTimeout(timeout); resolve(value); };
    socket.once(name, listener);
  });
}

async function connectClient() {
  const socket = createClient(serverUrl, { transports: ["websocket"], autoConnect: false, reconnection: false });
  clients.push(socket);
  const connected = event(socket, "connect");
  socket.connect();
  await connected;
  return socket;
}

before(async () => {
  await new Promise<void>(resolve => server.httpServer.listen(0, "127.0.0.1", resolve));
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  clients.forEach(client => client.disconnect());
  server.close();
});

test("host-authorized playback, late-join state, ordered commands, and room capacity", async () => {
  const host = await connectClient();
  const hostJoined = event<{ code: string }>(host, "room:joined");
  const hostInitialPlayback = event<{ playing: boolean; position: number; sequence: number; serverTimestamp: number }>(host, "playback:state");
  host.emit("room:create", { name: "Host User" });
  const room = await hostJoined;
  const initial = await hostInitialPlayback;
  assert.equal(initial.playing, false);
  assert.equal(initial.sequence, 0);
  assert.ok(initial.serverTimestamp > 0);

  const guest = await connectClient();
  const guestJoined = event<{ code: string }>(guest, "room:joined");
  const guestInitialPlayback = event<{ sequence: number }>(guest, "playback:state");
  const hostRoomAfterJoin = event<{ selectedMovie: MovieDetails | null }>(host, "room:state");
  guest.emit("room:join", { name: "Guest User", code: room.code });
  await guestJoined;
  assert.equal((await hostRoomAfterJoin).selectedMovie, null);
  assert.equal((await guestInitialPlayback).sequence, 0);

  const guestMovieDenied = event<{ message: string }>(guest, "movie:error");
  guest.emit("movie:select", { movieId: testMovie.id });
  assert.match((await guestMovieDenied).message, /Only the current host/);

  const invalidMovieSelection = event<{ message: string }>(host, "movie:error");
  host.emit("movie:select", { movieId: -1 });
  assert.match((await invalidMovieSelection).message, /invalid/);

  const hostMovieSelected = event<MovieDetails>(host, "movie:selected");
  const guestMovieSelected = event<MovieDetails>(guest, "movie:selected");
  const hostRoomAfterMovieSelection = event<{ selectedMovie: MovieDetails | null }>(host, "room:state");
  const guestRoomAfterMovieSelection = event<{ selectedMovie: MovieDetails | null }>(guest, "room:state");
  host.emit("movie:select", { movieId: testMovie.id });
  assert.deepEqual(await hostMovieSelected, testMovie);
  assert.deepEqual(await guestMovieSelected, testMovie);
  assert.deepEqual((await hostRoomAfterMovieSelection).selectedMovie, testMovie);
  assert.deepEqual((await guestRoomAfterMovieSelection).selectedMovie, testMovie);

  const optionalFieldsSelected = event<MovieDetails>(guest, "movie:selected");
  const hostOptionalFields = event<{ selectedMovie: MovieDetails | null }>(host, "room:state");
  host.emit("movie:select", { movieId: 551 });
  const selectedWithMissingArrays = await optionalFieldsSelected;
  assert.deepEqual(selectedWithMissingArrays.genreIds, []);
  assert.deepEqual(selectedWithMissingArrays.genres, []);
  assert.deepEqual((await hostOptionalFields).selectedMovie, selectedWithMissingArrays);

  assert.deepEqual(normalizeMovieDetails({ ...testMovie, genreIds: undefined, genres: undefined }).genreIds, []);
  assert.deepEqual(normalizeMovieDetails({ ...testMovie, genres: [{ id: 18 }, null, { id: 99, name: "" }] }).genres, [{ id: 99, name: "" }]);
  const restoredMovie = event<MovieDetails>(guest, "movie:selected");
  host.emit("movie:select", { movieId: testMovie.id });
  await restoredMovie;

  const invalidSearchResponse = await fetch(`${serverUrl}/api/movies/search?page=0`);
  assert.equal(invalidSearchResponse.status, 400);
  const genreResponse = await fetch(`${serverUrl}/api/movies/genres`);
  assert.deepEqual((await genreResponse.json() as { genres: Array<{ id: number; name: string }> }).genres, [{ id: 18, name: "Drama" }]);
  const detailsResponse = await fetch(`${serverUrl}/api/movies/${testMovie.id}`);
  assert.deepEqual(await detailsResponse.json(), testMovie);
  const invalidDetailsResponse = await fetch(`${serverUrl}/api/movies/not-a-number`);
  assert.equal(invalidDetailsResponse.status, 400);

  const forbidden = event<{ message: string }>(guest, "playback:error");
  guest.emit("playback:command", { action: "play" });
  assert.match((await forbidden).message, /Only the current host/);

  const playing = event<{ playing: boolean; sequence: number }>(host, "playback:state");
  host.emit("playback:command", { action: "play" });
  const playingState = await playing;
  assert.equal(playingState.playing, true);
  assert.equal(playingState.sequence, 1);

  await new Promise(resolve => setTimeout(resolve, 40));
  const lateGuest = await connectClient();
  const lateJoined = event<{ code: string; selectedMovie: MovieDetails | null }>(lateGuest, "room:joined");
  const latePlayback = event<{ playing: boolean; position: number; sequence: number; serverTimestamp: number }>(lateGuest, "playback:state");
  lateGuest.emit("room:join", { name: "Late Guest", code: room.code });
  assert.deepEqual((await lateJoined).selectedMovie, testMovie);
  const lateState = await latePlayback;
  assert.equal(lateState.playing, true);
  assert.equal(lateState.sequence, 1);
  assert.ok(lateState.position > 0);
  assert.ok(lateState.serverTimestamp > 0);

  const seeked = event<{ position: number; sequence: number }>(host, "playback:state");
  const guestSeeked = event<{ position: number; sequence: number }>(guest, "playback:state");
  host.emit("playback:command", { action: "seek", position: 42 });
  const seekState = await seeked;
  await guestSeeked;
  assert.ok(Math.abs(seekState.position - 42) < 0.1);
  assert.equal(seekState.sequence, 2);

  const paused = event<{ playing: boolean; sequence: number }>(host, "playback:state");
  const guestPaused = event<{ playing: boolean; sequence: number }>(guest, "playback:state");
  host.emit("playback:command", { action: "pause" });
  const pausedState = await paused;
  await guestPaused;
  assert.equal(pausedState.playing, false);
  assert.equal(pausedState.sequence, 3);

  const hostRestart = event<{ playing: boolean; position: number; sequence: number; restarted?: boolean }>(host, "playback:state");
  const guestRestart = event<{ playing: boolean; position: number; sequence: number; restarted?: boolean }>(guest, "playback:state");
  host.emit("playback:command", { action: "restart" });
  const [hostRestartState, guestRestartState] = await Promise.all([hostRestart, guestRestart]);
  for (const restartState of [hostRestartState, guestRestartState]) {
    assert.equal(restartState.playing, true);
    assert.equal(restartState.position, 0);
    assert.equal(restartState.sequence, 4);
    assert.equal(restartState.restarted, true);
  }

  const hostBuffering = event<{ playing: boolean; buffering: boolean; position: number; sequence: number }>(host, "playback:state");
  const guestBuffering = event<{ playing: boolean; buffering: boolean; position: number; sequence: number }>(guest, "playback:state");
  host.emit("playback:buffering", { buffering: true, position: 18 });
  for (const state of [await hostBuffering, await guestBuffering]) {
    assert.equal(state.playing, false);
    assert.equal(state.buffering, true);
    assert.equal(state.position, 18);
    assert.equal(state.sequence, 5);
  }

  const hostResumed = event<{ playing: boolean; buffering: boolean; position: number; sequence: number }>(host, "playback:state");
  const guestResumed = event<{ playing: boolean; buffering: boolean; position: number; sequence: number }>(guest, "playback:state");
  host.emit("playback:buffering", { buffering: false, position: 19.5 });
  for (const state of [await hostResumed, await guestResumed]) {
    assert.equal(state.playing, true);
    assert.equal(state.buffering, false);
    assert.equal(state.position, 19.5);
    assert.equal(state.sequence, 6);
  }

  const recoveredDisconnect = event<string>(host, "disconnect");
  host.io.engine.close();
  await recoveredDisconnect;
  const recoveredConnect = event(host, "connect");
  const recoveredRoom = event<{ code: string }>(host, "room:joined");
  const recoveredPlayback = event<{ sequence: number; playing: boolean }>(host, "playback:state");
  host.connect();
  await recoveredConnect;
  assert.equal(host.recovered, true);
  assert.equal((await recoveredRoom).code, room.code);
  const recoveredState = await recoveredPlayback;
  assert.equal(recoveredState.playing, true);
  assert.equal(recoveredState.sequence, 6);
  assert.ok(recoveredState.position >= 0);

  const transferred = event<{ participants: Array<{ id: string; isHost: boolean }> }>(guest, "room:state");
  host.emit("room:transfer-host", guest.id);
  assert.equal((await transferred).participants.find(person => person.id === guest.id)?.isHost, true);
  const deniedAfterTransfer = event<{ message: string }>(host, "playback:error");
  host.emit("playback:command", { action: "play" });
  assert.match((await deniedAfterTransfer).message, /Only the current host/);

  const hostReassigned = event<{ participants: Array<{ id: string; isHost: boolean }> }>(host, "room:state");
  guest.emit("room:leave");
  assert.equal((await hostReassigned).participants.find(person => person.id === host.id)?.isHost, true);

  const openFilmCatalog = await fetch(`${serverUrl}/api/open-films`);
  const catalog = await openFilmCatalog.json() as { films: Array<{ id: string; videoUrl: string; license: string }> };
  assert.equal(catalog.films[0]?.id, "big-buck-bunny");
  assert.match(catalog.films[0]?.videoUrl || "", /^https:\/\//);
  assert.match(catalog.films[0]?.license || "", /CC BY 3\.0/);

  const invalidOpenFilm = event<{ message: string }>(host, "open-film:error");
  host.emit("open-film:select", { filmId: "not-in-catalog" });
  assert.match((await invalidOpenFilm).message, /approved open-film catalog/);

  const openFilmDeniedForGuest = event<{ message: string }>(lateGuest, "open-film:error");
  lateGuest.emit("open-film:select", { filmId: "big-buck-bunny" });
  assert.match((await openFilmDeniedForGuest).message, /Only the current host/);

  const filmSelectedByHost = event<{ id: string; videoUrl: string }>(host, "open-film:selected");
  const filmSelectedByGuest = event<{ id: string; videoUrl: string }>(lateGuest, "open-film:selected");
  const roomWithFilm = event<{ selectedOpenFilm: { id: string } | null }>(host, "room:state");
  const playbackResetByFilm = event<{ playing: boolean; position: number; sequence: number }>(host, "playback:state");
  host.emit("open-film:select", { filmId: "big-buck-bunny" });
  assert.equal((await filmSelectedByHost).id, "big-buck-bunny");
  assert.equal((await filmSelectedByGuest).id, "big-buck-bunny");
  assert.equal((await roomWithFilm).selectedOpenFilm?.id, "big-buck-bunny");
  const pausedAtNewFilm = await playbackResetByFilm;
  assert.equal(pausedAtNewFilm.playing, false);
  assert.equal(pausedAtNewFilm.position, 0);
  assert.equal(pausedAtNewFilm.sequence, 7);

  const lateFilmViewer = await connectClient();
  const lateFilmViewerJoined = event<{ selectedOpenFilm: { id: string } | null }>(lateFilmViewer, "room:joined");
  lateFilmViewer.emit("room:join", { name: "Film Viewer", code: room.code });
  assert.equal((await lateFilmViewerJoined).selectedOpenFilm?.id, "big-buck-bunny");

  for (let index = 0; index < 7; index += 1) {
    const member = await connectClient();
    const joined = event<{ code: string }>(member, "room:joined");
    member.emit("room:join", { name: `Member ${index + 1}`, code: room.code });
    assert.equal((await joined).code, room.code);
  }
  const overflow = await connectClient();
  const fullError = event<{ message: string }>(overflow, "room:error");
  overflow.emit("room:join", { name: "Too Many", code: room.code });
  assert.match((await fullError).message, /full/);
});
