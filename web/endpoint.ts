/** Static builds choose one public API base; paths can never escape its prefix. */
export function apiEndpoint(base: string, path: string) {
  if (!/^\/api\/[a-z0-9/-]+$/.test(path) || path.includes("//")) {
    throw new Error("Rota de interface inválida.");
  }
  if (!base) return path;
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Base pública da API inválida.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "") + path;
}
export function sitePath(base: string, path: string) {
  if (
    !path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("?") ||
    path.includes("#")
  ) throw new Error("Caminho de interface inválido.");
  return new URL(base).pathname.replace(/\/+$/, "") + path;
}
