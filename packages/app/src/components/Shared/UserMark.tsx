"use client";

/**
 * The person, as their initials.
 *
 * This replaced a pulsing green square, which said only "connected" — a fact
 * the address printed beside it already carried, restated as an animation that
 * never stopped moving. A payments app is not a status console; the chip should
 * say WHO you are signed in as.
 *
 * Initials come from the username once it exists. Before that there is nothing
 * honest to abbreviate — an address has no initials, and slicing hex into two
 * characters invents an identity rather than showing one — so the mark falls
 * back to a static dot. Same size and position either way, so claiming a
 * username changes the glyph and never the layout.
 */
export function UserMark({
  username,
  size = "md",
}: {
  username?: string | null;
  size?: "sm" | "md";
}) {
  const px = size === "sm" ? 18 : 22;
  const initial = initialsFor(username);

  if (!initial) {
    return (
      <span
        aria-hidden
        className="bg-signal/60 shrink-0"
        style={{ width: px / 3, height: px / 3 }}
      />
    );
  }

  return (
    <span
      // The name is already rendered next to this in most placements, so the
      // mark itself is decorative and must not be announced twice.
      aria-hidden
      className="flex items-center justify-center shrink-0 bg-signal text-signal-ink font-mono font-bold leading-none"
      // 0.55 rather than the 0.45 two letters needed: one letter in the same
      // box would otherwise look lost in it.
      style={{ width: px, height: px, fontSize: px * 0.55 }}
    >
      {initial}
    </span>
  );
}

/**
 * The initial: one letter, the first of the name.
 *
 * Ivan is I. Not IV -- an initial is the first letter of a name, and two
 * letters of one word reads as an abbreviation of something else.
 *
 * A leading digit or underscore is skipped in favour of the first LETTER, so
 * "_ivan" and "2fast" still show a letter rather than punctuation; only a name
 * with no letters at all falls back to its first character.
 */
export function initialsFor(username?: string | null): string {
  const name = (username ?? "").trim();
  if (!name) return "";
  const firstLetter = name.match(/[A-Za-z]/)?.[0];
  return (firstLetter ?? name[0]!).toUpperCase();
}
