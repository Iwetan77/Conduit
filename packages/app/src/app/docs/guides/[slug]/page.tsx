import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { renderMarkdown } from "@/lib/markdown";

// Repo-root docs/*.md, rendered as the public docs site. These are the same
// files scripts/*.ts generate and check, so the site cannot drift from what is
// verified in the repo.
const DOCS_DIR = join(process.cwd(), "..", "..", "docs");

const SLUGS = ["quickstart", "payment-gateway", "errors", "webhooks", "currencies", "fx-timing", "fx-capability", "state-diagrams", "payment-links", "point-of-sale", "settlement-addresses"];

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
    <>{renderMarkdown(source)}</>
  );
}
