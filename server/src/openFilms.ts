export type OpenFilm = {
  id: string;
  title: string;
  year: number;
  videoUrl: string;
  attribution: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
};

// Big Buck Bunny is a Blender Foundation open movie released under CC BY 3.0.
// The media is streamed from Internet Archive; it is not copied into this repository.
export const OPEN_FILMS: OpenFilm[] = [
  {
    id: "big-buck-bunny",
    title: "Big Buck Bunny",
    year: 2008,
    videoUrl: "https://archive.org/download/BigBuckBunny_328/BigBuckBunny_512kb.mp4",
    attribution: "© 2008 Blender Foundation / www.bigbuckbunny.org",
    license: "Creative Commons Attribution 3.0 (CC BY 3.0)",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    sourceUrl: "https://archive.org/details/BigBuckBunny_328",
  },
];

export function getOpenFilm(id: string) {
  return OPEN_FILMS.find(film => film.id === id);
}
