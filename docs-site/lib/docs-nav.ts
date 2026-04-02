export interface DocLink {
  title: string;
  slug: string;
}

export interface NavSection {
  section: string;
  links: DocLink[];
}

export interface NavGroup {
  group: string;
  icon: string;
  /** URL prefix for this group's pages. Empty string = root-level pages. */
  prefix: string;
  /** If set, strip this prefix from content slugs to derive URL slugs. */
  stripPrefix?: string;
  sections: NavSection[];
}

const navigation: NavGroup[] = [
  {
    group: "Getting Started",
    icon: "rocket",
    prefix: "",
    sections: [
      {
        section: "Getting Started",
        links: [
          { title: "What is MetaMCP?", slug: "what-is-metamcp" },
          { title: "Installation", slug: "install" },
          { title: "Quick Start", slug: "quick-start" },
          { title: "Configuration", slug: "configuration" },
        ],
      },
    ],
  },
  {
    group: "Concepts",
    icon: "book-open",
    prefix: "concepts",
    sections: [
      {
        section: "Concepts",
        links: [
          { title: "Architecture", slug: "architecture" },
          { title: "The Four Tools", slug: "the-four-tools" },
          { title: "Connection Pool", slug: "connection-pool" },
          { title: "Circuit Breaker", slug: "circuit-breaker" },
          { title: "V8 Sandbox", slug: "sandbox" },
          { title: "Discovery & Search", slug: "discovery" },
        ],
      },
    ],
  },
  {
    group: "Guides",
    icon: "terminal",
    prefix: "guides",
    sections: [
      {
        section: "Guides",
        links: [
          { title: "Adding Servers", slug: "adding-servers" },
          { title: "Code Mode", slug: "code-mode" },
          { title: "Auto-Provisioning", slug: "auto-provisioning" },
          { title: "Claude Desktop Setup", slug: "claude-desktop" },
          { title: "Claude Code Setup", slug: "claude-code" },
        ],
      },
    ],
  },
  {
    group: "Reference",
    icon: "file-text",
    prefix: "reference",
    sections: [
      {
        section: "Reference",
        links: [
          { title: "Tool Reference", slug: "tool-reference" },
          { title: "CLI Reference", slug: "cli-reference" },
          { title: "Config Schema", slug: "config-schema" },
          { title: "Troubleshooting", slug: "troubleshooting" },
          { title: "Contributing", slug: "contributing" },
        ],
      },
    ],
  },
];

export function getAllNavGroups(): NavGroup[] {
  return navigation;
}

/** Flat list of all sections across all groups */
export function getAllSections(): NavSection[] {
  return navigation.flatMap((g) => g.sections);
}

/** All content slugs for static generation */
export function getAllSlugs(): string[] {
  return navigation.flatMap((g) =>
    g.sections.flatMap((s) => s.links.map((l) => l.slug))
  );
}

/** Get the URL slug portion (after prefix) for a content slug */
function getUrlSlug(contentSlug: string, group: NavGroup): string {
  if (group.stripPrefix && contentSlug.startsWith(group.stripPrefix)) {
    return contentSlug.slice(group.stripPrefix.length);
  }
  return contentSlug;
}

/** Get the full URL path for a content slug */
export function getPathForSlug(slug: string): string {
  for (const group of navigation) {
    for (const section of group.sections) {
      if (section.links.some((l) => l.slug === slug)) {
        const urlSlug = getUrlSlug(slug, group);
        if (!group.prefix) return `/${urlSlug}`;
        return `/${group.prefix}/${urlSlug}`;
      }
    }
  }
  return `/docs/${slug}`;
}

/** Resolve a path like ["guides", "export-formats"] or ["what-is-metamcp"] to a content slug */
export function getSlugForPath(pathSegments: string[]): string | null {
  if (pathSegments.length === 1) {
    // Root-level page (Getting Started)
    const urlSlug = pathSegments[0];
    for (const group of navigation) {
      if (group.prefix !== "") continue;
      for (const section of group.sections) {
        const link = section.links.find((l) => getUrlSlug(l.slug, group) === urlSlug);
        if (link) return link.slug;
      }
    }
    return null;
  }

  if (pathSegments.length === 2) {
    const [prefix, urlSlug] = pathSegments;
    for (const group of navigation) {
      if (group.prefix !== prefix) continue;
      for (const section of group.sections) {
        const link = section.links.find((l) => getUrlSlug(l.slug, group) === urlSlug);
        if (link) return link.slug;
      }
    }
    return null;
  }

  return null;
}

/** Get all content slugs for a given group prefix */
export function getSlugsForPrefix(prefix: string): { contentSlug: string; urlSlug: string }[] {
  for (const group of navigation) {
    if (group.prefix !== prefix) continue;
    return group.sections.flatMap((s) =>
      s.links.map((l) => ({
        contentSlug: l.slug,
        urlSlug: getUrlSlug(l.slug, group),
      }))
    );
  }
  return [];
}

/** Get all root-level slugs (Getting Started, no prefix) */
export function getRootSlugs(): { contentSlug: string; urlSlug: string }[] {
  return getSlugsForPrefix("");
}

/** Find prev/next navigation links across all sections */
export function getPrevNext(
  slug: string
): { prev: DocLink | null; next: DocLink | null } {
  const allLinks = navigation.flatMap((g) =>
    g.sections.flatMap((s) => s.links)
  );
  const index = allLinks.findIndex((l) => l.slug === slug);

  return {
    prev: index > 0 ? allLinks[index - 1] : null,
    next: index < allLinks.length - 1 ? allLinks[index + 1] : null,
  };
}

/** Get section name for a given slug */
export function getSectionForSlug(slug: string): string {
  for (const group of navigation) {
    for (const section of group.sections) {
      if (section.links.some((l) => l.slug === slug)) {
        return section.section;
      }
    }
  }
  return "";
}

/** Get group name for a given slug */
export function getGroupForSlug(slug: string): string {
  for (const group of navigation) {
    for (const section of group.sections) {
      if (section.links.some((l) => l.slug === slug)) {
        return group.group;
      }
    }
  }
  return "";
}

/** Get group object for a given slug */
export function getNavGroupForSlug(slug: string): NavGroup | null {
  for (const group of navigation) {
    for (const section of group.sections) {
      if (section.links.some((l) => l.slug === slug)) {
        return group;
      }
    }
  }
  return null;
}
