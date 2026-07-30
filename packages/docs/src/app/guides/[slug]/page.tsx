import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { DocNav } from "@/components/DocNav";
import { renderMarkdown } from "@/lib/markdown";

// Repo-root docs/*.md — the same files GATE 0/4 generate and check, and the
// same files STATUS.md and scripts/*.ts reference. This route is what makes
// them actually readable as a website instead of only living in the repo.
const DOCS_DIR = join(process.cwd(), "..", "..", "docs");

const SLUGS = ["quickstart", "errors", "webhooks", "currencies", "fx-timing", "fx-capability", "state-diagrams"];

export function generateStaticParams() {
  return SLUGS.map((slug) => ({ slug }));
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const path = join(DOCS_DIR, `${slug}.md`);
  if (!SLUGS.includes(slug) || !existsSync(path)) {
    notFound();
  }
  const source = readFileSync(path, "utf8");

  return (
    <div className="min-h-screen bg-bg">
      <DocNav />
      <main className="relative max-w-3xl mx-auto px-6 pt-28 pb-24">{renderMarkdown(source)}</main>
    </div>
  );
}
