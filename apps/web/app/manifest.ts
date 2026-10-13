import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ordivia",
    short_name: "Ordivia",
    description: "Hospitality, in order.",
    start_url: "/oggi",
    display: "standalone",
    background_color: "#faf6ef",
    theme_color: "#0e2235",
    lang: "it",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
