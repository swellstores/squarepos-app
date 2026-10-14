/**
 * Square signs each notice with HMAC-SHA256 over the address it was registered with,
 * followed by the body as sent, and puts the result in a header as base64.
 */

function fromBase64(text: string): ArrayBuffer | undefined {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    return undefined;
  }
}

export async function validSignature(signatureKey: string, address: string, body: string, signature: string | null): Promise<boolean> {
  const given = signature ? fromBase64(signature) : undefined;
  if (!signatureKey || !address || !given) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(signatureKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // verify() compares in constant time
  return crypto.subtle.verify("HMAC", key, given, encoder.encode(address + body));
}
