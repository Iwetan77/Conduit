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
  const initials = initialsFor(username);

  if (!initials) {
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
      style={{ width: px, height: px, fontSize: px * 0.45 }}
    >
      {initials}
    </span>
  );
}

/**
 * One or two letters from a username.
 *
 * Splits on the separators a person actually uses inside a handle
 * ("ada_lovelace" -> AL), and otherwise takes the first two letters rather than
 * a single one, which reads as an accident at this size. Digits are skipped
 * when a letter is available, so "ivan2024" is IV and not I2.
 */
export function initialsFor(username?: string | null): string {
  const name = (username ?? "").trim();
  if (!name) return "";

  const parts = name.split(/[_\s.-]+/).filter(Boolean);
  if (parts.length > 1) {
    const first = parts[0]![0];
    const second = parts[1]![0];
    return `${first}${second}`.toUpperCase();
  }

  const letters = name.replace(/[^A-Za-z]/g, "");
  const source = letters.length >= 2 ? letters : name;
  return source.slice(0, 2).toUpperCase();
}
