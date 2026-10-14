import { markSwellItem, startSync } from "./lib/marks";
import type { Settings } from "./lib/settings";

export const config: SwellConfig = {
  description: "Marks the linked item when its stock changes in Swell, and starts a sync",
  model: {
    events: ["product.stock_adjusted"],
    conditions: { $settings: { inventory: { enabled: true } } },
  },
};

export default async function (req: SwellRequest) {
  const settings = ((await req.swell.settings()) || {}) as Settings;
  if (settings.inventory?.enabled !== true) {
    return { skipped: "The stock sync is switched off" };
  }
  const change = req.data.$event?.data || {};
  const variantId: string | null = change.variant_id || null;
  // The event names the stock of the store as a whole. With a Swell stock location the
  // number to compare is another one, so the pair is marked whatever the event says
  const level: unknown = (settings.inventory?.swell_location || "").trim() ? undefined : variantId ? change.variant_stock_level : change.stock_level;
  const marked = await markSwellItem(req.swell, req.data.id as string, variantId, typeof level === "number" ? level : undefined);
  if (marked === 0) {
    return { skipped: "Not a linked item, or the app's own change" };
  }
  return { marked, started: (await startSync(req.swell, "swell", {}, (promise) => req.context.waitUntil(promise))) || null };
}
