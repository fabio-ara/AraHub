/** Official Moodle mobile launch links carry a site marker, Web Service token, and sometimes a private token. */
export function parseMoodleMobileLink(value: string): string {
  const link = value.trim();
  const match = /^[a-z][a-z0-9+.-]*:\/\/token=([A-Za-z0-9+/]+={0,2})$/i.exec(link);
  if (!match || match[1].length > 512 || match[1].length % 4 !== 0) {
    throw new Error("O link de entrada Moodle é inválido.");
  }
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    throw new Error("O link de entrada Moodle é inválido.");
  }
  const parts = decoded.split(":::");
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    !/^[a-f0-9]{32}$/i.test(parts[0]) ||
    !/^[a-f0-9]{32}$/i.test(parts[1]) ||
    (parts.length === 3 && !/^[a-f0-9]{32}$/i.test(parts[2]))
  ) throw new Error("O link de entrada Moodle é inválido.");
  // Never forward the third, private auto-login token to AraHub.
  return parts[1];
}

export function moodleMobileLaunchUrl(origin: string, passport: string): string {
  const site = new URL(origin);
  if (
    site.protocol !== "https:" || site.username || site.password || site.search || site.hash ||
    !/^[a-f0-9]{32}$/i.test(passport)
  ) throw new Error("Confira o endereço HTTPS do Moodle.");
  const base = site.href.endsWith("/") ? site.href : `${site.href}/`;
  const url = new URL("admin/tool/mobile/launch.php", base);
  url.search = new URLSearchParams({
    service: "moodle_mobile_app",
    passport,
    urlscheme: "moodlemobile",
    confirmed: "1",
  }).toString();
  return url.href;
}
