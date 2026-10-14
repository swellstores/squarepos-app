/**
 * Ids and keys derived from what they stand for, so that a step taken twice writes the same
 * record or sends the same request, and the second time changes nothing.
 */

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A record id of the store's form (24 hex digits) that is always the same for the same text */
export async function recordId(text: string): Promise<string> {
  return hex((await sha256(text)).slice(0, 12));
}

/**
 * A record id that starts with a time, as the store's own ids do, and is always the same for
 * the same time and text. Lists sorted by id (the dashboard's orders, a product's stock
 * history) then show the record in its place in time.
 */
export async function timedId(date: string, text: string): Promise<string> {
  const seconds = Math.floor(new Date(date).getTime() / 1000);
  return seconds.toString(16).padStart(8, "0").slice(-8) + (await recordId(text)).slice(0, 16);
}

/** A request key for Square (at most 45 characters there for some requests, 128 for others) */
export async function requestKey(text: string): Promise<string> {
  return hex((await sha256(text)).slice(0, 20));
}

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}
