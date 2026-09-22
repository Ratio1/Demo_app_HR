/**
 * Pure, framework-free so it is unit-testable without a DOM (tests/unit/initials.test.ts).
 * Tokens.md §5.10: "Initials only, computed from the person's name — never a portrait or
 * remote image." First + last name initial; a single-word name falls back to its first two
 * characters so the avatar is never left blank.
 */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  const first = parts[0]!.charAt(0);
  const last = parts[parts.length - 1]!.charAt(0);
  return `${first}${last}`.toUpperCase();
}
