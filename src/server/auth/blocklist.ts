/**
 * The bundled common-password blocklist (spec §6 S1).
 *
 * Local and small on purpose: no network service, no downloaded corpus, no runtime fetch. The
 * 15-character floor already excludes the short classics, so the list holds the long ones —
 * padded keyboard runs, repeated words, and the phrases this application would attract.
 *
 * Matching is done on the NFKC-normalized, lowercased, whitespace-stripped password, and a
 * password made of one repeated character or one long ascending run is refused arithmetically
 * rather than by enumeration.
 */

/** Entries are stored lowercase and compared after the same normalization. */
const BLOCKED: readonly string[] = [
  "123456789012345",
  "1234567890123456",
  "12345678901234567890",
  "111111111111111",
  "000000000000000",
  "aaaaaaaaaaaaaaa",
  "qwertyuiopasdfg",
  "qwertyuiopasdfgh",
  "qwertyuiop123456",
  "asdfghjklqwertyu",
  "zxcvbnmasdfghjkl",
  "1qaz2wsx3edc4rfv",
  "passwordpassword",
  "password12345678",
  "password123456789",
  "passw0rdpassw0rd",
  "letmeinletmein12",
  "iloveyouiloveyou",
  "administrator123",
  "administrator1234",
  "adminadminadmin1",
  "welcometothejungle",
  "welcome123456789",
  "changemechangeme",
  "changeme12345678",
  "trustno1trustno1",
  "monkeymonkeymonkey",
  "dragondragondragon",
  "football12345678",
  "baseball12345678",
  "superman12345678",
  "sunshinesunshine",
  "princessprincess",
  "qwerty1234567890",
  "abcdefghijklmnop",
  "abcd1234abcd1234",
  "thisisapassword1",
  "thisismypassword",
  "correcthorsebatterystaple",
  "temporarypassword",
  "temppassword1234",
  "defaultpassword1",
  "secretsecretsecret",
  "demoapphrdemoapphr",
  "demo_app_hrdemo_app_hr",
  "demoapphrpassword",
  "hradminhradminhr",
  "hradminpassword1",
  "employeeemployee",
  "employeepassword",
  "companypassword1",
  "januaryfebruary1",
  "summerwinter1234",
  "whateverwhatever",
  "nopasswordhere12",
  "iamnotapassword1",
  "loginloginlogin1",
  "opensesameopensesame",
  "startrekstartrek",
  "starwarsstarwars",
];

const BLOCKED_SET: ReadonlySet<string> = new Set(BLOCKED);

/** How many entries ship in the image; asserted by a unit test so the list cannot vanish. */
export const BLOCKLIST_SIZE = BLOCKED.length;

/** NFKC, lowercase, whitespace removed - the comparison form, never a stored form. */
function comparisonForm(password: string): string {
  return password.normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, "");
}

function isSingleRepeatedCharacter(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const characters = [...value];
  const first = characters[0] as string;
  return characters.every((character) => character === first);
}

/** `abcdefghij…` or `1234567890…` (or their reverse) across the whole value. */
function isMonotonicRun(value: string): boolean {
  const codes = [...value].map((character) => character.codePointAt(0) ?? 0);
  if (codes.length < 2) {
    return false;
  }
  let ascending = true;
  let descending = true;
  for (let index = 1; index < codes.length; index += 1) {
    const previous = codes[index - 1] as number;
    const current = codes[index] as number;
    if (current !== previous + 1) {
      ascending = false;
    }
    if (current !== previous - 1) {
      descending = false;
    }
  }
  return ascending || descending;
}

/** True when the password is on the bundled list or is trivially patterned. */
export function isBlockedPassword(password: string): boolean {
  const candidate = comparisonForm(password);
  if (candidate.length === 0) {
    return true;
  }
  return (
    BLOCKED_SET.has(candidate) || isSingleRepeatedCharacter(candidate) || isMonotonicRun(candidate)
  );
}
