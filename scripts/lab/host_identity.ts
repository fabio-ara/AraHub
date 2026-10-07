/** Native-session lookup for the temporary, explicitly authorized host Lab.
 * Uses the existing protected Management API credential; never accepts SQL,
 * endpoints or identity claims from the browser as a query.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 4096;

export function createHostSessionProbe(config: {
  identityOrigin: string;
  ownerId: string;
  expiresAt: number;
  signal: AbortSignal;
  credential: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const origin = new URL(config.identityOrigin);
  const project = /^([a-z0-9]{20})\.supabase\.co$/.exec(origin.hostname)?.[1];
  if (
    !project || origin.protocol !== "https:" || origin.port || origin.username ||
    origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    !UUID.test(config.ownerId) || !Number.isFinite(config.expiresAt)
  ) throw Error("Identidade nativa fora do alvo permitido para homologação.");
  const endpoint = `https://api.supabase.com/v1/projects/${project}/database/query`;
  const fetcher = config.fetcher ?? fetch, now = config.now ?? Date.now;
  return async (owner: string, session: string): Promise<boolean> => {
    if (
      owner !== config.ownerId || !UUID.test(session) || config.signal.aborted ||
      now() >= config.expiresAt
    ) return false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const token = (await config.credential()).trim();
      if (
        !token || /[\r\n]/.test(token) || config.signal.aborted || now() >= config.expiresAt
      ) return false;
      // Strict UUIDs above are the only variable SQL values. A boolean result
      // avoids returning session records or any other user's identity data.
      const query =
        `select exists(select 1 from auth.sessions where user_id='${owner}'::uuid and id='${session}'::uuid) as active`;
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.any([
          config.signal,
          AbortSignal.timeout(Math.max(1, Math.min(10000, config.expiresAt - now()))),
        ]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return false;
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) return false;
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return !config.signal.aborted && now() < config.expiresAt &&
        Array.isArray(result) && result.length === 1 && result[0]?.active === true;
    } catch {
      // Auth fails closed. Neither provider errors nor protected credentials
      // are included in a receipt, response or log.
      return false;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  };
}
