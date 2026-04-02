import { notFound } from "next/navigation";
import { getDocPage } from "@/lib/content";
import { getSlugsForPrefix, getPrevNext, getGroupForSlug, getPathForSlug } from "@/lib/docs-nav";
import { buildSearchIndex } from "@/lib/search-index";
import DocPageContent from "@/components/DocPageContent";

const PREFIX = "guides";

export function generateStaticParams() {
  return getSlugsForPrefix(PREFIX).map(({ urlSlug }) => ({ slug: urlSlug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entries = getSlugsForPrefix(PREFIX);
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
      images: [
        {
          url: "https://metamcp.org/opengraph-image.png",
          width: 1200,
          height: 630,
          alt: "MetaMCP - OS for MCP servers",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${doc.title} - MetaMCP Docs`,
      description: doc.description || doc.excerpt,
      images: ["https://metamcp.org/twitter-image.png"],
    },
    alternates: {
      canonical: url,
    },
  };
}

export default async function GuidesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entries = getSlugsForPrefix(PREFIX);
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
