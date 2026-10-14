/**
 * Matching: finds, for the variations of Square's catalog, the Swell product or variant
 * with the same SKU, and records each as a pair that can be started or as not linked, with
 * the reason. It writes only the app's own records: no stock moves, and nothing changes in
 * Square or on a product.
 */

import { linkKey } from "./marks";
import { wholeQuantity } from "./merge";
import { writeErrors } from "./settings";
import type { Page, StoreClient } from "./settings";
import { call, readVariations, retrieveCounts } from "./square";
import type { Api, Variation } from "./square";

type Row = Record<string, any>;

export interface MatchContext {
  swell: StoreClient;
  api: Api;
  locationId: string;
  swellLocation?: string;
}

export interface MatchOutcome {
  /** Pairs that can be started, or are in sync */
  matched: number;
  /** Variations recorded as not linked, with the reason */
  unlinked: number;
  /** Variations without a SKU, which are not recorded */
  without_sku: number;
}

interface Target {
  product_id: string;
  variant_id: string | null;
  swell_name: string;
  level: number;
  tracked: boolean;
}

function levelOf(record: Row, location: string | undefined): number {
  const level = location ? record.stock_locations?.[location]?.stock_level : record.stock_level;
  return typeof level === "number" ? level : 0;
}

/** The Swell products and variants that carry one of the SKUs, by SKU */
async function findInSwell(ctx: MatchContext, skus: string[]): Promise<Map<string, (Target | { problem: string })[]>> {
  const found = new Map<string, (Target | { problem: string })[]>();
  const add = (sku: string, target: Target | { problem: string }) => found.set(sku, [...(found.get(sku) || []), target]);
  const fields = "name,sku,stock_level,stock_locations,stock_tracking,options,parent_id";

  const [products, variants] = (await Promise.all([
    ctx.swell.get("/products", { where: { sku: { $in: skus } }, fields, limit: 1000 }),
    ctx.swell.get("/products:variants", { where: { sku: { $in: skus } }, fields, limit: 1000 }),
  ])) as Page[];

  for (const product of products?.results || []) {
    // A product with variants keeps its stock on them
    if ((product.options || []).some((option: Row) => option?.variant)) {
      add(product.sku, { problem: "The Swell product with this SKU has variants. Stock is kept on the variants: give each its own SKU." });
      continue;
    }
    add(product.sku, {
      product_id: product.id,
      variant_id: null,
      swell_name: product.name,
      level: levelOf(product, ctx.swellLocation),
      tracked: product.stock_tracking === true,
    });
  }

  const parentIds = [...new Set((variants?.results || []).map((variant) => variant.parent_id as string))].filter(Boolean);
  const parents = new Map<string, Row>();
  if (parentIds.length > 0) {
    const page = (await ctx.swell.get("/products", { where: { id: { $in: parentIds } }, fields: "name,stock_tracking", limit: parentIds.length })) as Page;
    for (const parent of page?.results || []) {
      parents.set(parent.id, parent);
    }
  }
  for (const variant of variants?.results || []) {
    const parent = parents.get(variant.parent_id);
    if (!parent) {
      continue;
    }
    add(variant.sku, {
      product_id: variant.parent_id,
      variant_id: variant.id,
      swell_name: `${parent.name} – ${variant.name}`,
      level: levelOf(variant, ctx.swellLocation),
      tracked: parent.stock_tracking === true,
    });
  }
  return found;
}

function squareName(variation: Variation): string {
  return variation.name && variation.name !== "Regular" ? `${variation.item_name} – ${variation.name}` : variation.item_name;
}

/** What the record of a variation should say */
function decide(variation: Variation, sameSku: number, targets: (Target | { problem: string })[] | undefined): Row {
  const unlinked = (reason: string): Row => ({ status: "unlinked", reason, product_id: null, variant_id: null, swell_name: null, swell_level: null });
  if (sameSku > 1) {
    return unlinked("More than one Square variation has this SKU. Give each its own.");
  }
  if (!targets || targets.length === 0) {
    return unlinked("No Swell product or variant has this SKU.");
  }
  if (targets.length > 1) {
    return unlinked("More than one Swell product or variant has this SKU. Give each its own.");
  }
  const [target] = targets;
  if ("problem" in target) {
    return unlinked(target.problem);
  }
  const pair = { product_id: target.product_id, variant_id: target.variant_id, swell_name: target.swell_name, swell_level: target.level };
  if (variation.measured) {
    return { ...pair, status: "unlinked", reason: "Square sells this item by weight or measure. Only whole quantities can be shared with Swell." };
  }
  if (!variation.tracked) {
    return { ...pair, status: "unlinked", reason: "Square does not track stock for this item at the location. Turn on stock tracking in Square, then match again." };
  }
  if (!target.tracked) {
    return { ...pair, status: "unlinked", reason: "The Swell product does not track stock. Turn on stock tracking for the product, then match again." };
  }
  return { ...pair, status: "ready", reason: null };
}

/** Matches the variations of one page of Square's catalog items */
export async function matchItems(ctx: MatchContext, items: Row[]): Promise<MatchOutcome> {
  const outcome: MatchOutcome = { matched: 0, unlinked: 0, without_sku: 0 };
  const all = items.flatMap((item) => readVariations(item, ctx.locationId)).filter((variation) => variation.present);
  outcome.without_sku = all.filter((variation) => !variation.sku).length;
  const variations = all.filter((variation) => variation.sku);
  if (variations.length === 0) {
    return outcome;
  }
  const skus = [...new Set(variations.map((variation) => variation.sku))];
  const keys = variations.map((variation) => linkKey(ctx.locationId, variation.id));

  const [targets, known, sameSku, counts] = await Promise.all([
    findInSwell(ctx, skus),
    ctx.swell.get("/items", { where: { key: { $in: keys } }, limit: keys.length }) as Promise<Page>,
    // Variations with the same SKU on another page of the catalog are known by their records
    ctx.swell.get("/items", { where: { sku: { $in: skus }, location_id: ctx.locationId }, limit: 1000 }) as Promise<Page>,
    retrieveCounts(
      ctx.api,
      variations.map((variation) => variation.id),
      ctx.locationId,
    ),
  ]);
  const records = new Map<string, Row>((known?.results || []).map((record) => [record.key, record]));
  const others = (sameSku?.results || []).filter((record) => !records.has(record.key));
  // Items that hold a Swell product or variant already, under another Square variation (one
  // whose SKU changed since it was started, for example): one Swell stock has one partner.
  // Items of another Square location hold nothing: the sync passes them by
  const targetIds = [...new Set([...targets.values()].flat().map((target) => ("product_id" in target ? target.product_id : "")).filter(Boolean))];
  const holders =
    targetIds.length > 0
      ? (((await ctx.swell.get("/items", {
          where: { product_id: { $in: targetIds }, location_id: ctx.locationId, status: { $in: ["active", "error", "ready"] } },
          limit: 1000,
        })) as Page)?.results || [])
      : [];
  const heldBy = (key: string, decided: Row) =>
    holders.find((holder) => holder.key !== key && holder.product_id === decided.product_id && (holder.variant_id || null) === (decided.variant_id || null));

  for (const variation of variations) {
    const key = linkKey(ctx.locationId, variation.id);
    const twins = variations.filter((other) => other.sku === variation.sku).length + others.filter((record) => record.sku === variation.sku).length;
    let decided = decide(variation, twins, targets.get(variation.sku));
    const holder = decided.status === "ready" ? heldBy(key, decided) : undefined;
    if (holder) {
      decided = { ...decided, status: "unlinked", reason: `The Swell product or variant is linked to another Square item ("${holder.name}"). Stop that one first, or give this one its SKU.` };
    }
    const record = records.get(key);
    const details = {
      name: squareName(variation),
      sku: variation.sku,
      square_level: wholeQuantity(counts.get(variation.id)) ?? null,
    };

    let result: unknown;
    if (!record) {
      result = await ctx.swell.post("/items", { key, location_id: ctx.locationId, variation_id: variation.id, ...details, ...decided });
    } else if (record.status === "active" || (record.status === "error" && decided.status === "ready" && record.product_id === decided.product_id && record.variant_id === decided.variant_id)) {
      // A pair that is in sync, or that stopped, is the sync's: only what the list shows is kept current
      if (record.name !== details.name || record.sku !== details.sku) {
        result = await ctx.swell.put(`/items/${record.id}`, { name: details.name, sku: details.sku });
      }
    } else {
      const changed = Object.entries({ ...details, ...decided }).some(([field, value]) => (record[field] ?? null) !== (value ?? null));
      if (changed) {
        result = await ctx.swell.put(`/items/${record.id}`, { ...details, ...decided, agreed: null, start: null });
      }
    }
    const errors = writeErrors(result);
    if (errors) {
      throw new Error(`Unable to save the stock link for ${variation.sku}: ${errors}`);
    }
    const status = record?.status === "active" ? "active" : decided.status;
    if (status === "unlinked") {
      outcome.unlinked += 1;
    } else {
      outcome.matched += 1;
    }
  }

  // A second variation with a SKU makes the first one's pair ambiguous as well
  for (const other of others) {
    if (other.status === "ready" && variations.some((variation) => variation.sku === other.sku)) {
      await ctx.swell.put(`/items/${other.id}`, {
        status: "unlinked",
        reason: "More than one Square variation has this SKU. Give each its own.",
      });
    }
  }
  return outcome;
}

/**
 * After a match: records of variations that Square no longer has. One that was never
 * started is removed; one that is in sync stops with the reason.
 */
export async function dropMissing(ctx: MatchContext, links: Row[]): Promise<number> {
  if (links.length === 0) {
    return 0;
  }
  const data = await call(ctx.api, "POST", "/catalog/batch-retrieve", { object_ids: links.map((link) => link.variation_id) });
  const present = new Set<string>(((data.objects || []) as Row[]).filter((object) => !object.is_deleted).map((object) => object.id));
  let dropped = 0;
  for (const link of links) {
    if (present.has(link.variation_id)) {
      continue;
    }
    if (link.status === "active") {
      await ctx.swell.put(`/items/${link.id}`, { status: "error", reason: "The item was deleted in Square.", marked: false });
    } else if (link.status !== "error") {
      await ctx.swell.delete(`/items/${link.id}`);
    }
    dropped += 1;
  }
  return dropped;
}
