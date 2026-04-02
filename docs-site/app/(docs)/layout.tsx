"use client";

import { useState } from "react";
import DocsHeader from "@/components/DocsHeader";
import DocsSidebar from "@/components/DocsSidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <DocsHeader onMenuToggle={() => setMobileOpen(!mobileOpen)} />
      <DocsSidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <div className="lg:pl-64 pt-14">{children}</div>
    </>
  );
}
