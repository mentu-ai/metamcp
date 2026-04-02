import { notFound } from "next/navigation";
import { getDocPage } from "@/lib/content";
import { getRootSlugs, getPrevNext, getGroupForSlug, getPathForSlug } from "@/lib/docs-nav";
import { buildSearchIndex } from "@/lib/search-index";
import DocPageContent from "@/components/DocPageContent";

export function generateStaticParams() {
  return getRootSlugs().map(({ urlSlug }) => ({ slug: urlSlug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entries = getRootSlugs();
  const entry = entries.find((e) => e.urlSlug === slug);
  if (!entry) return {};

  const doc = await getDocPage(entry.contentSlug);
  if (!doc) return {};

  const url = `https://metamcp.org${getPathForSlug(entry.contentSlug)}`;
  return {
    title: `${doc.title} - MetaMCP Docs`,
    description: doc.description || doc.excerpt,
    openGraph: {
      title: `${doc.title} - MetaMCP Docs`,
      description: doc.description || doc.excerpt,
      url,
      siteName: "MetaMCP Docs",
      type: "article",
    },
    twitter: {
      card: "summary",
      title: `${doc.title} - MetaMCP Docs`,
      description: doc.description || doc.excerpt,
    },
    alternates: {
      canonical: url,
    },
  };
}

export default async function RootDocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entries = getRootSlugs();
  const entry = entries.find((e) => e.urlSlug === slug);
  if (!entry) notFound();

  const doc = await getDocPage(entry.contentSlug);
  if (!doc) notFound();

  const group = getGroupForSlug(entry.contentSlug);
  const { prev, next } = getPrevNext(entry.contentSlug);
  const searchEntries = buildSearchIndex();

  return (
    <DocPageContent
      doc={doc}
      group={group}
      prev={prev}
      next={next}
      searchEntries={searchEntries}
    />
  );
}
