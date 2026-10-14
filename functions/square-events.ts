import { markSquareCounts, requestSalesSearch, startSync } from "./lib/marks";
import { salesEnabled, stockEnabled } from "./lib/settings";
import type { Settings } from "./lib/settings";
import { validSignature } from "./lib/signature";
import { readState } from "./lib/state";

export const config: SwellConfig = {
  description: "Receives Square's notices of stock counts, payments and refunds, and starts a sync for what they announce",
  route: { methods: ["post"], public: true },
};

// The time of the last notice is kept for the check that notices arrive at all
const RECEIVED_EVERY_MS = 10 * 60 * 1000;

export async function post(req: SwellRequest) {
  // Anybody can call a public route. Only Square knows the key its notices are signed with
  const webhook = await readState(req.swell, "webhook");
  const signed = await validSignature(
    webhook?.signature_key || "",
    webhook?.address || "",
    req.rawBody || "",
    req.headers.get("x-square-hmacsha256-signature"),
  );
  if (!webhook || !signed) {
    return new SwellResponse({ error: "The signature does not match" }, { status: 401 });
  }

  const settings = ((await req.swell.settings()) || {}) as Settings;
  const event = (typeof req.body === "object" && req.body) || {};
  const type = String(event.type || "");
  let work = false;

  if (type === "inventory.count.updated") {
    if (stockEnabled(settings)) {
      work = (await markSquareCounts(req.swell, event.data?.object?.inventory_counts || [])) > 0;
    }
  } else if (type.startsWith("payment.") || type.startsWith("refund.")) {
    if (salesEnabled(settings)) {
      await requestSalesSearch(req.swell);
      work = true;
    }
  }

  const received = new Date(webhook.date_received || 0).getTime();
  if (Date.now() - received > RECEIVED_EVERY_MS) {
    await req.swell.put(`/state/${webhook.id}`, { date_received: new Date().toISOString() });
  }

  const started = work ? await startSync(req.swell, "square") : undefined;
  return { received: type, work, started: started || null };
}
