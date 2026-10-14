/**
 * What the app needs from the store's own settings, which only functions can read and
 * write: a workflow is limited to the app's own settings.
 */

import { resolveSwellLocation } from "./locations";
import { PAYMENT_METHOD } from "./order";
import type { Settings, StoreClient } from "./settings";
import { readState, writeState } from "./state";

/**
 * Looks up the Swell stock location in the store's own settings and keeps the answer in the
 * app's state. A workflow cannot read those settings, so the functions do it for the sync.
 */
export async function rememberSwellLocation(swell: StoreClient, settings: Settings): Promise<{ problem?: string }> {
  const name = (settings.inventory?.swell_location || "").trim();
  if (!name) {
    return {};
  }
  const shipments = (await swell.get("/settings/shipments")) as Record<string, any> | null;
  const found = resolveSwellLocation(settings, shipments);
  const state = await readState(swell, "store");
  const values: Record<string, string | null> = { swell_location: name, swell_location_id: found.id || null, problem: found.problem || null };
  if (!state || Object.entries(values).some(([field, value]) => (state[field] ?? null) !== value)) {
    await writeState(swell, "store", values);
  }
  return { problem: found.problem };
}

/**
 * The payment method imported sales are recorded with: a manual method named Square POS,
 * switched off so that shoppers never see it. The store accepts a payment record with any
 * method in its list, and the dashboard shows an order as paid only with such a record.
 */
export async function ensurePaymentMethod(swell: StoreClient): Promise<void> {
  const payments = (await swell.get("/settings/payments")) as { methods?: { id?: string }[] } | null;
  if ((payments?.methods || []).some((method) => method?.id === PAYMENT_METHOD)) {
    return;
  }
  await swell.put("/settings/payments", { methods: [{ id: PAYMENT_METHOD, name: "Square POS", manual: true, enabled: false }] });
}
