// Minimal markdown -> JSX renderer. No dependency added for this — the docs
// content (headings, fenced code, tables, links, bold, inline code, lists) is
// simple enough that pulling in a full markdown/MDX pipeline wasn't worth a
// new dependency for a handful of generated docs pages. Mermaid blocks are
// rendered as labeled code (no mermaid.js — same reasoning).
import type { ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let i = 0;
  const pattern = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/;

  while (remaining.length > 0) {
    const match = pattern.exec(remaining);
    if (!match) {
      nodes.push(remaining);
      break;
    }
    if (match.index > 0) nodes.push(remaining.slice(0, match.index));
    if (match[1]) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="px-1 py-0.5 bg-surface text-signal text-[0.9em]">
          {match[4]}
        </code>
      );
    } else if (match[5]) {
      const href = match[7]!;
      const isExternal = /^https?:\/\//.test(href);
      nodes.push(
        <a
          key={`${keyPrefix}-${i++}`}
          href={href}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="text-signal hover:underline"
        >
          {match[6]}
        </a>
      );
    }
    remaining = remaining.slice(match.index + match[0].length);
  }
  return nodes;
}

export function renderMarkdown(source: string): ReactNode {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <div key={key++} className="my-4">
          {lang && lang !== "mermaid" && (
            <div className="text-[10px] uppercase tracking-widest text-ink-dim font-mono mb-1">{lang}</div>
          )}
          {lang === "mermaid" && (
            <div className="text-[10px] uppercase tracking-widest text-ink-dim font-mono mb-1">
              diagram (mermaid source — render with any mermaid-compatible viewer)
            </div>
          )}
          <pre className="p-4 overflow-x-auto text-[12px] leading-relaxed border border-border bg-surface">
            <code className="text-ink font-mono">{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    if (line.startsWith("| ")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      const rows = tableLines.filter((l) => !/^\|[\s-|]+\|$/.test(l)).map((l) =>
        l.split("|").slice(1, -1).map((c) => c.trim())
      );
      const [header, ...body] = rows;
      blocks.push(
        <div key={key++} className="my-4 overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {header?.map((h, ci) => (
                  <th key={ci} className="text-left px-3 py-2 text-ink-dim font-mono text-[11px] uppercase tracking-wider">
                    {renderInline(h, `th-${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className="border-b border-border">
                  {row.map((c, ci) => (
                    <td key={ci} className="px-3 py-2 text-ink-dim align-top">
                      {renderInline(c, `td-${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push(<h3 key={key++} className="text-lg font-semibold text-ink mt-8 mb-2">{renderInline(line.slice(4), `h3-${key}`)}</h3>);
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(<h2 key={key++} className="text-2xl font-semibold text-ink mt-10 mb-3">{renderInline(line.slice(3), `h2-${key}`)}</h2>);
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(<h1 key={key++} className="text-3xl font-bold text-ink mb-4">{renderInline(line.slice(2), `h1-${key}`)}</h1>);
      i++;
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith("- ") || lines[i]!.startsWith("* "))) {
        items.push(lines[i]!.slice(2));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc list-inside space-y-1 my-3 text-ink-dim">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `li-${key}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\. /, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal list-inside space-y-1 my-3 text-ink-dim">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `oli-${key}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: consume until blank line or next block-starting line
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("#") &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("| ") &&
      !lines[i]!.startsWith("- ") &&
      !/^\d+\. /.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-ink-dim leading-relaxed my-3">
        {renderInline(paraLines.join(" "), `p-${key}`)}
      </p>
    );
  }

  return <>{blocks}</>;
}
