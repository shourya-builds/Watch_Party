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
export type MovieDetails = MovieSummary & { genres: MovieGenre[] };
export type MovieSearchParams = {
  query: string;
  genreId?: number;
  year?: number;
  sortBy: "popularity.desc" | "vote_average.desc" | "primary_release_date.desc" | "primary_release_date.asc";
  page: number;
};
export type MovieSearchPage = { page: number; totalPages: number; totalResults: number; results: MovieSummary[] };

export interface MovieService {
  getGenres(): Promise<MovieGenre[]>;
  search(params: MovieSearchParams): Promise<MovieSearchPage>;
  getDetails(id: number): Promise<MovieDetails>;
}

export class MovieServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "MovieServiceError";
  }
}

const API_BASE = "https://api.themoviedb.org/3";
const SORT_VALUES: MovieSearchParams["sortBy"][] = [
  "popularity.desc",
  "vote_average.desc",
  "primary_release_date.desc",
  "primary_release_date.asc",
];

async function request<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!apiKey) throw new MovieServiceError("Movie discovery is not configured yet. Add TMDB_API_KEY to the server environment.", 503);

  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MovieServiceError("The movie service could not be reached. Check the server connection and try again.", 502);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new MovieServiceError("TMDB rejected the server API key. Check TMDB_API_KEY and try again.", 502);
    }
    if (response.status === 404) throw new MovieServiceError("That movie could not be found.", 404);
    throw new MovieServiceError("The movie service returned an error. Please try again.", 502);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new MovieServiceError("The movie service returned an invalid response.", 502);
  }
}

type TmdbMovie = {
  id?: number;
  title?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  vote_average?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: Array<{ id?: number; name?: string }>;
};

function movieSummary(movie: TmdbMovie): MovieSummary | null {
  if (!movie || typeof movie !== "object") return null;
  if (!Number.isSafeInteger(movie.id) || !movie.id || typeof movie.title !== "string") return null;
  return {
    id: movie.id,
    title: movie.title,
    overview: typeof movie.overview === "string" ? movie.overview : "",
    posterPath: typeof movie.poster_path === "string" ? movie.poster_path : null,
    releaseDate: typeof movie.release_date === "string" ? movie.release_date : "",
    voteAverage: typeof movie.vote_average === "number" && Number.isFinite(movie.vote_average) ? movie.vote_average : 0,
    popularity: typeof movie.popularity === "number" && Number.isFinite(movie.popularity) ? movie.popularity : 0,
    genreIds: Array.isArray(movie.genre_ids) ? movie.genre_ids.filter(Number.isSafeInteger) : [],
  };
}

/** Enforces the public movie-details contract, including optional TMDB arrays. */
export function normalizeMovieDetails(value: unknown): MovieDetails {
  if (!value || typeof value !== "object") throw new MovieServiceError("The movie service returned invalid movie details.", 502);
  const raw = value as TmdbMovie & Partial<MovieSummary>;
  const movie = movieSummary({
    id: raw.id,
    title: raw.title,
    overview: raw.overview,
    poster_path: raw.poster_path ?? raw.posterPath,
    release_date: raw.release_date ?? raw.releaseDate,
    vote_average: raw.vote_average ?? raw.voteAverage,
    popularity: raw.popularity,
    genre_ids: raw.genre_ids ?? raw.genreIds,
  });
  if (!movie) throw new MovieServiceError("The movie service returned invalid movie details.", 502);
  const rawGenres = raw.genres;
  const genres = Array.isArray(rawGenres)
    ? rawGenres.filter((genre): genre is { id: number; name: string } =>
      !!genre && Number.isSafeInteger(genre.id) && typeof genre.name === "string")
      .map(genre => ({ id: genre.id, name: genre.name }))
    : [];
  return { ...movie, genres };
}

export const tmdbMovieService: MovieService = {
  async getGenres() {
    const data = await request<{ genres?: Array<{ id?: number; name?: string }> }>("/genre/movie/list", { language: "en-US" });
    return (Array.isArray(data.genres) ? data.genres : []).filter(genre => Number.isSafeInteger(genre.id) && typeof genre.name === "string")
      .map(genre => ({ id: genre.id!, name: genre.name! }));
  },

  async search(params) {
    const isSearch = params.query.length > 0;
    const query: Record<string, string | number | boolean> = {
      language: "en-US",
      include_adult: false,
      page: params.page,
    };
    if (isSearch) {
      query.query = params.query;
      if (params.year) query.year = params.year;
    } else {
      query.sort_by = SORT_VALUES.includes(params.sortBy) ? params.sortBy : "popularity.desc";
      if (params.year) query.primary_release_year = params.year;
      if (params.genreId) query.with_genres = params.genreId;
    }
    const path = isSearch ? "/search/movie" : "/discover/movie";
    const data = await request<{ page?: number; total_pages?: number; total_results?: number; results?: TmdbMovie[] }>(path, query);
    let results = (Array.isArray(data.results) ? data.results : []).map(movieSummary).filter((movie): movie is MovieSummary => movie !== null);
    if (isSearch && params.genreId) results = results.filter(movie => movie.genreIds.includes(params.genreId!));
    if (isSearch) {
      const sorter = params.sortBy;
      results.sort((a, b) => {
        if (sorter === "vote_average.desc") return b.voteAverage - a.voteAverage;
        if (sorter === "primary_release_date.asc") return a.releaseDate.localeCompare(b.releaseDate);
        if (sorter === "primary_release_date.desc") return b.releaseDate.localeCompare(a.releaseDate);
        return b.popularity - a.popularity;
      });
    }
    return {
      page: data.page || params.page,
      totalPages: Math.min(data.total_pages || 0, 500),
      totalResults: data.total_results || 0,
      results,
    };
  },

  async getDetails(id) {
    const data = await request<TmdbMovie>(`/movie/${id}`, { language: "en-US" });
    return normalizeMovieDetails(data);
  },
};
