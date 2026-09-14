import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/seo";

const routes = [
  "/",
  "/about",
  "/programmes",
  "/mission-01",
  "/workshop",
  "/coaching",
  "/ai-recruiter-os",
  "/contact",
  "/privacy",
  "/terms",
  "/cookies",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl().toString().replace(/\/$/, "");
  return routes.map((route) => ({ url: `${base}${route}` }));
}
