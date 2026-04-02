import { getAllDocEntries } from "./content";
import { getSectionForSlug, getPathForSlug } from "./docs-nav";

export interface SearchEntry {
  slug: string;
  href: string;
  title: string;
  section: string;
  excerpt: string;
}

export function buildSearchIndex(): SearchEntry[] {
  return getAllDocEntries().map((entry) => ({
    ...entry,
    href: getPathForSlug(entry.slug),
    section: getSectionForSlug(entry.slug) || entry.section,
  }));
}
