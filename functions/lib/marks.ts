/**
 * A notice from either side only says "look at this item". The functions that receive
 * notices mark the pair and make sure a sync runs; the sync alone reads and writes stock.
 */

import { releaseClaim, takeClaim } from "./claim";
import { wholeQuantity } from "./merge";
import type { Page, StoreClient } from "./settings";
import { readState, writeState } from "./state";

export const WORKFLOW = "sync";

export function linkKey(locationId: string, variationId: string): string {
  return `${locationId}:${variationId}`;
}

type Link = Record<string, any>;

async function mark(swell: StoreClient, links: Link[], level: (link: Link) => number | undefined): Promise<number> {
  let marked = 0;
  for (const link of links) {
    // After a sync both sides hold "agreed". A notice that names that quantity announces
    // the sync's own change, or nothing new
    if (!link.step && link.agreed !== null && link.agreed !== undefined && level(link) === link.agreed) {
      continue;
    }
    if (link.marked !== true) {
      await swell.put(`/items/${link.id}`, { marked: true });
    }
    marked += 1;
  }
  return marked;
}

/** Marks the linked pairs that Square announced a new count for. Returns how many need a sync */
export async function markSquareCounts(
  swell: StoreClient,
  counts: { catalog_object_id?: string; location_id?: string; state?: string; quantity?: string }[],
): Promise<number> {
  const quantities = new Map<string, string | undefined>();
  for (const count of counts) {
    if (count.state === "IN_STOCK" && count.catalog_object_id && count.location_id) {
      quantities.set(linkKey(count.location_id, count.catalog_object_id), count.quantity);
    }
  }
  if (quantities.size === 0) {
    return 0;
  }
  const found = (await swell.get("/items", {
    where: { key: { $in: [...quantities.keys()] }, status: "active" },
    limit: quantities.size,
  })) as Page<Link>;
  return mark(swell, found?.results || [], (link) => wholeQuantity(quantities.get(link.key)));
}

/** Marks the linked pair of a product or variant whose stock changed in Swell */
export async function markSwellItem(swell: StoreClient, productId: string, variantId: string | null, level: number | undefined): Promise<number> {
  // A null in a query reaches the store as the text "null": the variant is compared here
  const found = (await swell.get("/items", {
    where: { product_id: productId, status: "active" },
    limit: 100,
  })) as Page<Link>;
  const links = (found?.results || []).filter((link) => (link.variant_id || null) === variantId);
  return mark(swell, links, () => level);
}

/** Notes that Square announced a payment or a refund: the next sync searches Square's orders */
export async function requestSalesSearch(swell: StoreClient): Promise<void> {
  const state = await readState(swell, "sales");
  if (state?.requested !== true) {
    await writeState(swell, "sales", { requested: true });
  }
}

type Starter = StoreClient & { workflows: { create(name: string, params?: unknown): Promise<unknown> } };

/**
 * Starts a sync unless one is running: the running one looks for new marks before it ends.
 * The claim is taken here, for the run, so that a burst of notices starts one run and not
 * one each. A function cannot do the work itself: it has ten seconds.
 */
export async function startSync(swell: Starter, source: string, params: Record<string, unknown> = {}): Promise<string | undefined> {
  const claim = crypto.randomUUID();
  if (!(await takeClaim(swell, claim))) {
    return undefined;
  }
  let run: { id?: string };
  try {
    run = (await swell.workflows.create(WORKFLOW, { source, claim, ...params })) as { id?: string };
  } catch (err) {
    await releaseClaim(swell, claim);
    throw err;
  }
  return run?.id || claim;
}
