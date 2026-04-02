import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <h1 className="text-6xl font-bold text-text-100 mb-4">404</h1>
        <p className="text-lg text-text-300 mb-8">
          This page doesn&apos;t exist or may have moved.
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-brand-500 text-white font-medium hover:bg-brand-600 transition-colors"
          >
            Back to Docs
          </Link>
          <div className="text-sm text-text-400 mt-4">
            <p className="mb-3">Popular pages:</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/install" className="text-brand-500 hover:text-brand-400 underline underline-offset-2">
                Install
              </Link>
              <span className="text-text-500">/</span>
              <Link href="/quick-start" className="text-brand-500 hover:text-brand-400 underline underline-offset-2">
                Quick Start
              </Link>
              <span className="text-text-500">/</span>
              <Link href="/concepts/architecture" className="text-brand-500 hover:text-brand-400 underline underline-offset-2">
                Architecture
              </Link>
              <span className="text-text-500">/</span>
              <Link href="/reference/tool-reference" className="text-brand-500 hover:text-brand-400 underline underline-offset-2">
                Tool Reference
              </Link>
              <span className="text-text-500">/</span>
              <Link href="/reference/troubleshooting" className="text-brand-500 hover:text-brand-400 underline underline-offset-2">
                Troubleshooting
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
