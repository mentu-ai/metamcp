"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import * as Accordion from "@radix-ui/react-accordion";
import { getAllNavGroups, getPathForSlug } from "@/lib/docs-nav";
import {
  Rocket,
  BookOpen,
  Server,
  Globe,
  Terminal,
  FileText,
  Wand2,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  rocket: Rocket,
  "book-open": BookOpen,
  server: Server,
  globe: Globe,
  terminal: Terminal,
  "file-text": FileText,
  wand: Wand2,
};

/** Find which section contains the current pathname */
function getActiveSections(pathname: string): string[] {
  const groups = getAllNavGroups();
  const active: string[] = [];
  for (const group of groups) {
    for (const section of group.sections) {
      for (const link of section.links) {
        if (getPathForSlug(link.slug) === pathname) {
          active.push(section.section);
        }
      }
    }
  }
  return active;
}

export default function DocsSidebar({
  mobileOpen,
  onClose,
}: {
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const groups = getAllNavGroups();

  const allSections = groups.flatMap((g) => g.sections.map((s) => s.section));
  const activeSections = getActiveSections(pathname);

  const sidebar = (isMobile: boolean) => (
    <Accordion.Root
      type="multiple"
      defaultValue={isMobile ? (activeSections.length > 0 ? activeSections : [allSections[0]]) : allSections}
      className="space-y-1"
    >
      {groups.map((group) => {
        const Icon = iconMap[group.icon];
        return (
        <div key={group.group} className="mb-5">
          {group.sections.map((section) => (
            <Accordion.Item key={section.section} value={section.section}>
              <Accordion.Trigger className="flex items-center justify-between w-full px-3 py-2 text-[11px] font-semibold text-text-300 uppercase tracking-widest hover:text-text-200 transition-colors group">
                <span className="flex items-center gap-2">
                  {Icon && <Icon className="w-4 h-4 text-text-400" />}
                  {section.section}
                </span>
                <ChevronDown className="w-3.5 h-3.5 accordion-chevron text-text-400" />
              </Accordion.Trigger>
              <Accordion.Content className="overflow-hidden data-[state=open]:animate-[slideDown_200ms_ease-out] data-[state=closed]:animate-[slideUp_200ms_ease-out]">
                <ul className="space-y-0.5 pb-2">
                  {section.links.map((link) => {
                    const href = getPathForSlug(link.slug);
                    const isActive = pathname === href;
                    return (
                      <li key={link.slug}>
                        <Link
                          href={href}
                          onClick={onClose}
                          className={`sidebar-link block px-3 py-1.5 text-sm rounded-lg transition-colors ${
                            isActive
                              ? "sidebar-link-active text-accent-primary font-medium"
                              : "text-text-300 hover:text-text-100"
                          }`}
                        >
                          {link.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </div>
        );
      })}
    </Accordion.Root>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={onClose}
          />
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-bg-100 p-4 pt-20 shadow-xl overflow-y-auto">
            {sidebar(true)}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 fixed top-14 bottom-0 bg-bg-100 overflow-y-auto p-4 border-r border-border-100">
        {sidebar(false)}
      </aside>
    </>
  );
}
