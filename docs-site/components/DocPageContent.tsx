import Link from "next/link";
import { getDocPage, type DocPage } from "@/lib/content";
import { getPrevNext, getGroupForSlug, getPathForSlug } from "@/lib/docs-nav";
import { buildSearchIndex } from "@/lib/search-index";
import DocsTableOfContents from "@/components/DocsTableOfContents";
import ProseContent from "@/components/ProseContent";
import CopyPageButton from "@/components/CopyPageButton";
import SearchModal from "@/components/SearchModal";
import JsonLd from "@/components/JsonLd";

export async function renderDocPage(slug: string) {
  const doc = await getDocPage(slug);
  if (!doc) return null;

  const group = getGroupForSlug(slug);
  const { prev, next } = getPrevNext(slug);
  const searchEntries = buildSearchIndex();

  return { doc, group, prev, next, searchEntries };
}

export default function DocPageContent({
  doc,
  group,
  prev,
  next,
  searchEntries,
}: {
  doc: DocPage;
  group: string;
  prev: { title: string; slug: string } | null;
  next: { title: string; slug: string } | null;
  searchEntries: { slug: string; href: string; title: string; section: string; excerpt: string }[];
}) {
  return (
    <>
      <JsonLd
        slug={doc.slug}
        title={doc.title}
        description={doc.description || doc.excerpt}
        headings={doc.headings}
      />
      <SearchModal entries={searchEntries} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <main className="flex-1 min-w-0 px-6 py-8 lg:px-10 lg:py-10 max-w-4xl mx-auto w-full">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-sm text-text-400 mb-6">
            <Link href="/" className="hover:text-text-200 transition-colors">
              Docs
            </Link>
            {group && (
              <>
                <span>/</span>
                <span className="text-text-400">{group}</span>
              </>
            )}
            <span>/</span>
            <span className="text-text-200">{doc.title}</span>
          </nav>

          {/* Title + Copy */}
          <div className="flex items-start justify-between gap-4 mb-8">
            <h1 className="text-3xl font-medium text-text-100 tracking-tight">
              {doc.title}
            </h1>
            <CopyPageButton content={doc.copyContent} />
          </div>

          {/* Content */}
          <ProseContent html={doc.htmlContent} />

          {/* Prev / Next */}
          <div className="flex items-center justify-between gap-4 mt-16 pt-8 border-t border-border-100">
            {prev ? (
              <Link
                href={getPathForSlug(prev.slug)}
                className="group flex flex-col gap-1 p-4 rounded-xl border border-border-100 hover:border-border-300 transition-colors max-w-[45%]"
              >
                <span className="text-xs text-text-400">Previous</span>
                <span className="text-sm text-text-200 group-hover:text-text-100 transition-colors">
                  {prev.title}
                </span>
              </Link>
            ) : (
              <div />
            )}
            {next ? (
              <Link
                href={getPathForSlug(next.slug)}
                className="group flex flex-col gap-1 p-4 rounded-xl border border-border-100 hover:border-border-300 transition-colors text-right max-w-[45%] ml-auto"
              >
                <span className="text-xs text-text-400">Next</span>
                <span className="text-sm text-text-200 group-hover:text-text-100 transition-colors">
                  {next.title}
                </span>
              </Link>
            ) : (
              <div />
            )}
          </div>

          {/* Footer */}
          <footer className="mt-12 pb-8 text-center text-xs text-text-400">
            &copy; {new Date().getFullYear()} MetaMCP. Open source under Apache-2.0.
          </footer>
        </main>

        {/* Right TOC */}
        <div className="hidden xl:block w-56 shrink-0 pr-6 pt-10">
          <DocsTableOfContents headings={doc.headings} />
        </div>
      </div>
    </>
  );
}
