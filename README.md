# Watch Party

Watch Party uses Next.js App Router, TypeScript, and Tailwind for the client, with an Express + Socket.IO server. Room state and synchronized playback state are held in memory.

## Run on Windows

```powershell
npm run install:all
npm run dev
```

Open http://localhost:3000. The server health check is http://localhost:4000/health.

Room features include six-character room codes, invite URLs (`?room=ABC123`), display-name validation, live participant updates, host transfer, automatic host transfer when the host leaves, a 10-person limit, leave/disconnect cleanup, and a health endpoint.

The room page includes a responsive HTML5 video player, host-only play/pause/seek, ordered authoritative playback snapshots, late-join synchronization, drift correction, and Socket.IO connection-state recovery. For local development it uses `web/public/samples/flower.mp4`, a small sample from MDN's interactive examples, released under CC0 1.0 (public domain dedication): https://github.com/mdn/interactive-examples.

### Playing an openly licensed film

The room sidebar also includes **Open-license films**. The initial catalog contains *Big Buck Bunny* (2008), streamed directly from Internet Archive rather than bundled or rehosted by this project. Its item lists the **Attribution 3.0 United States** license; the film's attribution is shown next to the player and the license link is available in the sidebar. The app retains its attribution and license link. Only the host can switch the room's playable source; selecting a source resets everyone to 0:00, paused, and the usual Socket.IO playback sync applies afterward. New/reconnected participants receive the current source with room state. Internet Archive availability and bandwidth are external dependencies; the local flower clip remains the fallback until the host selects a catalog film.

This catalog is deliberately allowlisted by the backend. It is not a mechanism for loading arbitrary movie URLs or bypassing a streaming service's access controls. Add only works whose licenses permit the intended use, and provide their required attribution. See the [Big Buck Bunny Internet Archive record](https://archive.org/details/BigBuckBunny_328) and its [CC BY 3.0 license](https://creativecommons.org/licenses/by/3.0/).

The sample video is bundled locally and served by Next.js, so the default does not rely on an external media host. The frontend reads `NEXT_PUBLIC_SAMPLE_VIDEO_URL` from `web/.env.local` (see `web/.env.example`); set it to a direct MP4/WebM URL if desired. Because `NEXT_PUBLIC_*` values are embedded into frontend code, restart the frontend after changing this setting (and rebuild before production deployment). Playback synchronization is designed for direct media URLs controlled by the browser's HTML5 video element. Third-party embeds such as YouTube need a separate provider-specific API integration and may impose playback or access restrictions.

Room and playback state are in memory. Restarting the server clears rooms; reconnect recovery is limited to brief network interruptions (15 seconds) while the server process remains running.

## Phase 3: Movie discovery and shared selection

The room sidebar's **Discover movies** button opens a searchable TMDB catalog with poster cards, release years, ratings, genre/year filters, sorting, details, and paginated results. Only the current room host can select a title. The server validates the movie ID and host permission, fetches canonical details from TMDB, then broadcasts the selected movie metadata to the room. Late joiners receive the current selection in their room snapshot.

### TMDB setup

1. Create a TMDB account and request a developer API key from the API section of your account settings: https://developer.themoviedb.org/docs/getting-started.
2. In the PowerShell terminal where you will run Watch Party, set the key as a server environment variable, then start the app:

   ```powershell
   $env:TMDB_API_KEY = "your_tmdb_v3_api_key"
   npm run dev
   ```

   If the app is already running, stop it and restart it from that same terminal after setting the variable. For deployment, configure `TMDB_API_KEY` in the backend service's environment. Do not prefix it with `NEXT_PUBLIC_`, paste it into frontend files, or commit it to source control. The backend reads the key and makes all authenticated TMDB API requests; browser requests go only to the local Express API.

3. Open a room and choose **Discover movies**. If the key is absent or rejected, the discovery view shows a setup/API error while the room and synchronized sample player remain usable.

The key is read from the server process environment; the app does not load a `server/.env` file. TMDB selection remains metadata only: TMDB provides title, synopsis, genres, ratings, and poster art here—not a playable stream. To play an actual title within this app, the host can select a licensed source from **Open-license films**; this is separate from TMDB metadata and does not change the selected TMDB movie.

The discovery screen includes the TMDB logo and required notice: “This product uses the TMDB API but is not endorsed or certified by TMDB.” See TMDB's [authentication guidance](https://developer.themoviedb.org/docs/authentication-application), [movie discovery API](https://developer.themoviedb.org/reference/discover-movie), [image URL guidance](https://developer.themoviedb.org/docs/image-basics), and [attribution requirements](https://developer.themoviedb.org/docs/faq). This project uses TMDB's API and imagery under its applicable terms; verify those terms for your own deployment and use.

### Local feature check

1. Start with the TMDB key configured as above, then open `http://localhost:3000`.
2. Create a room in one browser and join its invite link from a second browser.
3. Open **Discover movies**, try a title search and the genre, release-year, and sort filters, then open a result to inspect its details.
4. Select a movie as the host. Both room pages should show the same title and poster. As a guest, the selection action should be disabled; a direct guest selection request is rejected by the server.
5. Confirm the player still shows and synchronizes the separate demo video. Movie selection does not claim to provide or play the selected film.

The server test suite includes shared selection broadcast, host authorization, invalid selection/search requests, and late-join selection state, in addition to room/playback coverage.

Run `npm run lint`, `npm test`, and `npm run build` to lint, test room/playback/movie-selection server behavior, and build the applications.

Set `WEB_ORIGIN` and `NEXT_PUBLIC_SERVER_URL` when deploying the two processes separately.
