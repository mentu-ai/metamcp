import { getPathForSlug, getGroupForSlug } from "@/lib/docs-nav";

interface JsonLdProps {
  slug: string;
  title: string;
  description: string;
  headings?: { depth: number; text: string; id: string }[];
}

interface BreadcrumbItem {
  "@type": "ListItem";
  position: number;
  name: string;
  item: string;
}

function buildBreadcrumbSchema(slug: string, title: string) {
  const items: BreadcrumbItem[] = [
    { "@type": "ListItem", position: 1, name: "Docs", item: "https://metamcp.org" },
  ];

  const group = getGroupForSlug(slug);
  if (group) {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: group,
      item: `https://metamcp.org${getPathForSlug(slug)}`,
    });
    items.push({
      "@type": "ListItem",
      position: 3,
      name: title,
      item: `https://metamcp.org${getPathForSlug(slug)}`,
    });
  } else {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: title,
      item: `https://metamcp.org${getPathForSlug(slug)}`,
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  };
}

function buildSoftwareApplicationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "MetaMCP",
    operatingSystem: "Any",
    applicationCategory: "DeveloperApplication",
    description: "Meta-MCP server that collapses N child servers into 4 tools with connection pooling, hybrid search, and V8 sandbox.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

function buildTechArticleSchema(title: string, description: string, slug: string) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: `https://metamcp.org${getPathForSlug(slug)}`,
    publisher: {
      "@type": "Organization",
      name: "MetaMCP",
    },
  };
}

function buildFAQSchema(headings: { depth: number; text: string; id: string }[]) {
  // Extract h2 headings as question groups, h3 headings as individual questions
  const questions = headings
    .filter((h) => h.depth === 3)
    .map((h) => ({
      "@type": "Question" as const,
      name: h.text,
      acceptedAnswer: {
        "@type": "Answer" as const,
        text: `See the ${h.text} section in our troubleshooting guide for detailed steps.`,
      },
    }));

  if (questions.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions,
  };
}

// Slugs that get SoftwareApplication schema
const SOFTWARE_SLUGS = new Set(["install", "what-is-metamcp"]);
// Slugs that get TechArticle schema
const TECH_ARTICLE_SLUGS = new Set(["architecture", "tool-reference", "the-four-tools", "sandbox", "cli-reference"]);
// Slug that gets FAQ schema
const FAQ_SLUG = "troubleshooting";

export default function JsonLd({ slug, title, description, headings }: JsonLdProps) {
  const schemas: object[] = [];

  // Every page gets breadcrumbs
  schemas.push(buildBreadcrumbSchema(slug, title));

  // SoftwareApplication on install/overview pages
  if (SOFTWARE_SLUGS.has(slug)) {
    schemas.push(buildSoftwareApplicationSchema());
  }

  // TechArticle on reference/architecture pages
  if (TECH_ARTICLE_SLUGS.has(slug)) {
    schemas.push(buildTechArticleSchema(title, description, slug));
  }

  // FAQPage on troubleshooting
  if (slug === FAQ_SLUG && headings) {
    const faq = buildFAQSchema(headings);
    if (faq) schemas.push(faq);
  }

  return (
    <>
      {schemas.map((schema, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
      ))}
    </>
  );
}
