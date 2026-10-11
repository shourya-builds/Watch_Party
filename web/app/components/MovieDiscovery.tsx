"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

export type MovieGenre = { id: number; name: string };
export type MovieSummary = {
  id: number;
  title: string;
  overview: string;
  posterPath: string | null;
  releaseDate: string;
  voteAverage: number;
  popularity: number;
  genreIds: number[];
};
export type MovieDetails = Omit<MovieSummary, "genreIds"> & { genreIds: number[]; genres: MovieGenre[] };
export type MoviePage = { page: number; totalPages: number; totalResults: number; results: MovieSummary[] };

const API = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const TMDB_LOGO = "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg";
const SORT_OPTIONS = [
  ["popularity.desc", "Most popular"],
  ["vote_average.desc", "Top rated"],
  ["primary_release_date.desc", "Newest first"],
  ["primary_release_date.asc", "Oldest first"],
] as const;

type Props = {
  open: boolean;
  isHost: boolean;
  canSelect: boolean;
  selectedMovie: MovieDetails | null;
  selectionError: string;
  onClose: () => void;
  onSelect: (movieId: number) => void;
};

async function readApi<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load movie information.");
  return body;
}

function Poster({ path, title, className }: { path: string | null; title: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!path || failed) return <div className={`${className} grid place-items-center bg-slate-800 px-3 text-center text-xs text-slate-500`}>Poster unavailable</div>;
  return <div className={`${className} relative overflow-hidden`}><Image fill sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 180px" className="object-cover" src={`${POSTER_BASE}${path}`} alt={`${title} poster`} onError={() => setFailed(true)} /></div>;
}

export default function MovieDiscovery({ open, isHost, canSelect, selectedMovie, selectionError, onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [genreId, setGenreId] = useState("");
  const [year, setYear] = useState("");
  const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number][0]>("popularity.desc");
  const [page, setPage] = useState(1);
  const [genres, setGenres] = useState<MovieGenre[]>([]);
  const [results, setResults] = useState<MovieSummary[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<MovieDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [selectionPending, setSelectionPending] = useState(false);
  const detailsRequestRef = useRef<AbortController | null>(null);

  const years = useMemo(() => Array.from({ length: new Date().getFullYear() - 1899 }, (_, index) => new Date().getFullYear() - index), []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void readApi<{ genres: MovieGenre[] }>(`${API}/api/movies/genres`, controller.signal)
      .then(data => setGenres(data.genres))
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load movie genres."); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), sortBy });
    if (query.trim()) params.set("query", query.trim());
    if (genreId) params.set("genreId", genreId);
    if (year) params.set("year", year);
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void readApi<MoviePage>(`${API}/api/movies/search?${params}`, controller.signal)
        .then(data => { setResults(data.results); setTotalPages(data.totalPages); })
        .catch(cause => { if (!controller.signal.aborted) { setResults([]); setTotalPages(0); setError(cause instanceof Error ? cause.message : "Could not load movies."); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, genreId, year, sortBy, page]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (details) closeDetails(); else onClose(); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, details, onClose]);

  useEffect(() => {
    if (selectionError) setSelectionPending(false);
    if (selectedMovie && details?.id === selectedMovie.id) setSelectionPending(false);
  }, [selectionError, selectedMovie, details]);

  useEffect(() => () => detailsRequestRef.current?.abort(), []);

  function openDetails(movie: MovieSummary) {
    detailsRequestRef.current?.abort();
    const controller = new AbortController();
    detailsRequestRef.current = controller;
    setDetails(movie as MovieDetails);
    setDetailsError("");
    setDetailsLoading(true);
    void readApi<MovieDetails>(`${API}/api/movies/${movie.id}`, controller.signal)
      .then(setDetails)
      .catch(cause => { if (!controller.signal.aborted) setDetailsError(cause instanceof Error ? cause.message : "Could not load movie details."); })
      .finally(() => { if (!controller.signal.aborted) setDetailsLoading(false); });
  }

  function closeDetails() {
    detailsRequestRef.current?.abort();
    setDetails(null);
    setDetailsLoading(false);
  }

  function selectMovie() {
    if (!details || !isHost || !canSelect || selectionPending) return;
    setSelectionPending(true);
    onSelect(details.id);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#080d18]/95 p-3 backdrop-blur-sm sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="movie-discovery-title" className="mx-auto min-h-[calc(100dvh-1.5rem)] max-w-7xl rounded-2xl border border-slate-700 bg-[#0b1220] p-4 shadow-2xl sm:min-h-[calc(100dvh-3rem)] sm:p-6">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div><p className="text-xs font-semibold tracking-[0.2em] text-cyan-300">WATCH PARTY</p><h2 id="movie-discovery-title" className="mt-1 text-2xl font-bold sm:text-3xl">Discover a movie</h2><p className="mt-2 text-sm text-slate-400">Find a title and share the selection with your room.</p></div>
          <button type="button" onClick={onClose} aria-label="Close movie discovery" className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:border-cyan-300">Close</button>
        </header>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_190px_150px_205px]">
          <label className="sm:col-span-2 lg:col-span-1"><span className="mb-1 block text-xs text-slate-400">Search titles</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="Search movies…" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm outline-none focus:border-cyan-400" /></label>
          <label><span className="mb-1 block text-xs text-slate-400">Genre</span><select value={genreId} onChange={event => { setGenreId(event.target.value); setPage(1); }} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm outline-none focus:border-cyan-400"><option value="">All genres</option>{genres.map(genre => <option key={genre.id} value={genre.id}>{genre.name}</option>)}</select></label>
          <label><span className="mb-1 block text-xs text-slate-400">Release year</span><select value={year} onChange={event => { setYear(event.target.value); setPage(1); }} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm outline-none focus:border-cyan-400"><option value="">Any year</option>{years.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span className="mb-1 block text-xs text-slate-400">Sort by</span><select value={sortBy} onChange={event => { setSortBy(event.target.value as typeof sortBy); setPage(1); }} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm outline-none focus:border-cyan-400">{SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>

        {selectedMovie && <div className="mb-5 flex items-center gap-3 rounded-xl border border-cyan-900/70 bg-cyan-950/30 p-3"><Poster path={selectedMovie.posterPath} title={selectedMovie.title} className="h-16 w-11 shrink-0 rounded object-cover" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-cyan-300">Selected for this room</p><p className="truncate font-semibold">{selectedMovie.title}</p><p className="text-xs text-slate-400">Movie metadata only — the current sample video is unchanged.</p></div></div>}

        {error && <p role="alert" className="mb-5 rounded-lg border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-200">{error}</p>}
        {loading ? <div role="status" className="grid min-h-64 place-items-center text-slate-300"><span className="flex items-center gap-3"><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-300" />Loading movies…</span></div>
          : !error && results.length === 0 ? <div className="grid min-h-64 place-items-center text-center"><div><p className="font-semibold">No movies found</p><p className="mt-1 text-sm text-slate-400">Try another title or adjust the filters.</p></div></div>
            : !error && <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{results.map(movie => <button type="button" key={movie.id} onClick={() => openDetails(movie)} className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left transition hover:-translate-y-0.5 hover:border-cyan-400/70"><Poster path={movie.posterPath} title={movie.title} className="aspect-[2/3] w-full bg-slate-800 object-cover" /><span className="block p-3"><span className="line-clamp-2 block min-h-10 text-sm font-semibold group-hover:text-cyan-200">{movie.title}</span><span className="mt-2 flex items-center justify-between text-xs text-slate-400"><span>{movie.releaseDate?.slice(0, 4) || "Year unknown"}</span><span aria-label={`Rating ${movie.voteAverage.toFixed(1)} out of 10`} className="text-amber-300">★ {movie.voteAverage.toFixed(1)}</span></span></span></button>)}</div>}

        <nav aria-label="Movie result pages" className="mt-6 flex items-center justify-center gap-4">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-lg border border-slate-600 px-4 py-2 text-sm disabled:opacity-40">Previous</button>
          <span aria-live="polite" className="text-sm text-slate-400">Page {page}{totalPages ? ` of ${totalPages}` : ""}</span>
          <button type="button" disabled={loading || page >= totalPages} onClick={() => setPage(value => Math.min(totalPages, value + 1))} className="rounded-lg border border-slate-600 px-4 py-2 text-sm disabled:opacity-40">Next</button>
        </nav>

        <footer className="mt-8 flex flex-col items-start justify-between gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3"><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" aria-label="The Movie Database (TMDB)"><Image src={TMDB_LOGO} alt="The Movie Database (TMDB)" width={36} height={36} className="object-contain" /></a><div><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Credits</p><p className="max-w-xl text-xs text-slate-500">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div></div>
          <a className="text-xs text-cyan-300 underline" href="https://developer.themoviedb.org/docs/faq" target="_blank" rel="noreferrer">TMDB attribution information</a>
        </footer>
      </section>

      {details && <div className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/80 p-3 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) closeDetails(); }}>
        <article role="dialog" aria-modal="true" aria-labelledby="movie-detail-title" className="my-auto grid w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl sm:grid-cols-[240px_1fr]">
          <Poster path={details.posterPath} title={details.title} className="aspect-[2/3] max-h-[55vh] w-full bg-slate-800 object-cover sm:max-h-none" />
          <div className="flex min-w-0 flex-col p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><div><h3 id="movie-detail-title" className="text-xl font-bold">{details.title}</h3><p className="mt-1 text-sm text-slate-400">{details.releaseDate || "Release date unknown"}</p></div><button type="button" aria-label="Close movie details" onClick={closeDetails} className="rounded border border-slate-600 px-2 py-1 text-xs">Close</button></div>
            <p className="mt-4 text-sm leading-relaxed text-slate-300">{details.overview || "No synopsis is available."}</p>
            <div className="mt-4 flex flex-wrap gap-2">{details.genres.map(genre => <span key={genre.id} className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">{genre.name}</span>)}</div>
            <p className="mt-4 text-sm text-amber-300">★ {details.voteAverage.toFixed(1)} / 10</p>
            {detailsLoading && <p role="status" className="mt-3 text-xs text-slate-400">Loading full details…</p>}
            {detailsError && <p role="alert" className="mt-3 text-sm text-rose-300">{detailsError}</p>}
            <div className="mt-auto pt-6"><p className="mb-3 rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-400">TMDB provides movie information and artwork only. It does not provide a playable stream; selecting this title will not change the room’s current sample video.</p>
              <button type="button" disabled={!isHost || !canSelect || selectionPending || detailsLoading} onClick={selectMovie} className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">{selectionPending ? "Selecting…" : !isHost ? "Only the host can select" : !canSelect ? "Reconnect to select" : selectedMovie?.id === details.id ? "Selected for this room" : "Select for Watch Party"}</button>
              {selectionError && <p role="alert" className="mt-2 text-sm text-rose-300">{selectionError}</p>}
            </div>
          </div>
        </article>
      </div>}
    </div>
  );
}
