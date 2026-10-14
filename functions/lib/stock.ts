/**
 * The stock sync of linked pairs: reads both sides, decides with merge.ts what each has to
 * receive, and passes it on.
 *
 * Every change is written on the pair's record as a step before it is sent anywhere. The
 * request to Square carries references made from the step, and the Swell stock entry an id
 * made from it, so a step that is repeated after a failure changes nothing a second time.
 */

import { requestKey, timedId } from "./ids";
import { plan, squareAdjustments, squareParts, startingPoint, swellEntry, wholeQuantity } from "./merge";
import type { SquarePart, StockEntry, SwellReason } from "./merge";
import { writeErrors } from "./settings";
import type { Page, StoreClient } from "./settings";
import { SquareError, changeInventory, retrieveAdjustments, retrieveCounts } from "./square";
import type { Adjustment, AdjustmentInput, Api } from "./square";

export type Link = Record<string, any> & { id: string };

export interface Step {
  seq: number;
  /** When the step was decided. Also the time Square is told the change happened */
  date: string;
  to_square: number;
  to_swell: number;
  /** What both sides hold when the step is done */
  agreed: number;
  parts: SquarePart[];
  reason: SwellReason;
  message: string;
  /** When the quantities were read that the step was decided from */
  read: string;
  /** The Swell stock location the step was decided for */
  swell_location?: string | null;
}

export interface StockContext {
  swell: StoreClient;
  api: Api;
  /** The Square location that shares its stock with the store */
  locationId: string;
  /** The Swell stock location, in stores that keep stock by location */
  swellLocation?: string;
  /** Time (ms) after which no further pairs are started */
  deadline: number;
}

export interface Outcome {
  /** Pairs looked at */
  checked: number;
  /** Pairs with a change passed on */
  changed: number;
  /** Pairs that can no longer be synced */
  stopped: number;
  /** Pairs left for the next batch because time ran out */
  left: number;
}

/** Pairs are worked on a few at a time, so that a batch that runs out of time leaves the rest untouched */
const CHUNK = 10;
/** Requests to the store that run side by side */
const PARALLEL = 5;

async function each<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let from = 0; from < items.length; from += PARALLEL) {
    await Promise.all(items.slice(from, from + PARALLEL).map(work));
  }
}

async function save(swell: StoreClient, link: Link, values: Record<string, unknown>): Promise<void> {
  const result = await swell.put(`/items/${link.id}`, values);
  const errors = writeErrors(result);
  if (errors) {
    throw new Error(`Unable to save the stock link ${link.id}: ${errors}`);
  }
  Object.assign(link, values);
}

export function reference(link: Link, seq: number): string {
  return `swell:${link.id}:${seq}`;
}

/** The id of the Swell stock entry of a step: the history's running level follows the entry ids */
export async function entryId(link: Link, step: Pick<Step, "seq" | "date">): Promise<string> {
  return timedId(step.date, reference(link, step.seq));
}

/* Reading Swell */

function levelOf(record: Record<string, any>, location: string | undefined): number {
  const level = location ? record.stock_locations?.[location]?.stock_level : record.stock_level;
  return typeof level === "number" ? level : 0;
}

/** The Swell stock of each pair, by link id. A pair whose product or variant is gone has none */
export async function readSwellLevels(ctx: StockContext, links: Link[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  const productIds = [...new Set(links.filter((link) => !link.variant_id).map((link) => link.product_id as string))].filter(Boolean);
  const variantIds = [...new Set(links.map((link) => link.variant_id as string))].filter(Boolean);
  const fields = "stock_level,stock_locations";

  const [products, variants] = await Promise.all([
    productIds.length > 0
      ? (ctx.swell.get("/products", { where: { id: { $in: productIds } }, fields, limit: productIds.length }) as Promise<Page>)
      : undefined,
    variantIds.length > 0
      ? (ctx.swell.get("/products:variants", { where: { id: { $in: variantIds } }, fields, limit: variantIds.length }) as Promise<Page>)
      : undefined,
  ]);
  const byId = new Map<string, Record<string, any>>();
  for (const record of [...(products?.results || []), ...(variants?.results || [])]) {
    byId.set(record.id, record);
  }
  for (const link of links) {
    const record = byId.get(link.variant_id || link.product_id);
    if (record) {
      levels.set(link.id, levelOf(record, ctx.swellLocation));
    }
  }
  return levels;
}

/** Swell's stock entries of a pair since a time, without the one the app wrote itself */
async function entriesSince(ctx: StockContext, link: Link): Promise<StockEntry[]> {
  if (!link.date_read) {
    return [];
  }
  // A null in a query reaches the store as the text "null": the variant and the location are compared here
  const found = (await ctx.swell.get("/products:stock", {
    where: { parent_id: link.product_id, date_created: { $gt: link.date_read } },
    fields: "quantity,reason,variant_id,location",
    limit: 200,
  })) as Page<StockEntry & { variant_id?: string | null; location?: string | null }>;
  return (found?.results || []).filter(
    (entry) => entry.id !== link.entry_id && (entry.variant_id || null) === (link.variant_id || null) && (entry.location || null) === (ctx.swellLocation || null),
  );
}

/* The steps */

interface Work {
  link: Link;
  step: Step;
  /** Square has the step's change already: an earlier run sent it and stopped before the step was done */
  sent: boolean;
}

function changeText(step: Step): string {
  const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`).replace("-", "−");
  const parts: string[] = [];
  if (step.to_swell !== 0) {
    parts.push(`${signed(step.to_swell)} from Square`);
  }
  if (step.to_square !== 0) {
    parts.push(`${signed(step.to_square)} from Swell`);
  }
  return parts.join(", ");
}

async function stop(ctx: StockContext, link: Link, reason: string, outcome: Outcome): Promise<void> {
  await save(ctx.swell, link, { status: "error", reason, step: null, pending: false, marked: false });
  outcome.stopped += 1;
}

/** Sends the steps' changes to Square: together, and one pair at a time when Square refuses the lot */
async function sendToSquare(ctx: StockContext, work: Work[], outcome: Outcome): Promise<Work[]> {
  const sending = work.filter((item) => item.step.to_square !== 0 && !item.sent);
  if (sending.length === 0) {
    return work;
  }
  const refused = new Map<string, string>();

  const send = async (items: Work[]) => {
    const adjustments: AdjustmentInput[] = [];
    // Square orders changes by this time: a change dated back, behind a recount made since,
    // would not change the count. What Square already has is found by its reference, not by
    // the request key
    const occurredAt = new Date().toISOString();
    for (const item of items) {
      adjustments.push(...squareAdjustments(reference(item.link, item.step.seq), item.link.variation_id, item.step.parts));
    }
    const key = await requestKey(`${adjustments.map((adjustment) => adjustment.reference_id).join("|")}@${occurredAt}`);
    for (let from = 0; from < adjustments.length; from += 100) {
      await changeInventory(ctx.api, from === 0 ? key : `${key}-${from}`, ctx.locationId, adjustments.slice(from, from + 100), occurredAt);
    }
  };

  try {
    await send(sending);
  } catch (err) {
    if (!(err instanceof SquareError) || err.kind !== "refused") {
      throw err;
    }
    // Square takes a request whole or not at all: find the pair it refuses
    for (const item of sending) {
      try {
        await send([item]);
      } catch (single) {
        if (!(single instanceof SquareError) || single.kind !== "refused") {
          throw single;
        }
        refused.set(item.link.id, single.message);
      }
    }
  }

  const sent: Work[] = [];
  for (const item of work) {
    const message = refused.get(item.link.id);
    if (message) {
      // Nothing was changed on either side for this pair
      await stop(ctx, item.link, `Square refused the stock change. ${message}`, outcome);
    } else {
      sent.push(item);
    }
  }
  return sent;
}

/** Writes the step's stock entry. A refusal is the store's answer to the entry; trouble reaching the store is thrown */
async function writeToSwell(ctx: StockContext, item: Work): Promise<{ id?: string; refused?: string }> {
  const { link, step } = item;
  if (step.to_swell === 0) {
    return {};
  }
  const id = await entryId(link, step);
  const result = await ctx.swell.post("/products:stock", {
    id,
    parent_id: link.product_id,
    ...(link.variant_id ? { variant_id: link.variant_id } : {}),
    ...(ctx.swellLocation ? { location: ctx.swellLocation } : {}),
    quantity: step.to_swell,
    reason: step.reason,
    reason_message: step.message,
  });
  const errors = writeErrors(result);
  return errors ? { refused: errors } : { id };
}

async function finish(ctx: StockContext, work: Work[], outcome: Outcome): Promise<void> {
  const sent = await sendToSquare(ctx, work, outcome);
  await each(sent, async (item) => {
    const { link, step } = item;
    const entry = await writeToSwell(ctx, item);
    if (entry.refused) {
      // Square has its part of the step. The pair stops until the merchant starts it again
      await stop(ctx, link, `Swell refused the stock change. ${entry.refused}`, outcome);
      return;
    }
    await save(ctx.swell, link, {
      agreed: step.agreed,
      swell_level: step.agreed,
      square_level: step.agreed,
      oversold: step.agreed < 0,
      step: null,
      pending: false,
      start: null,
      reason: null,
      last_change: changeText(step),
      date_synced: new Date().toISOString(),
      date_read: step.read,
      swell_location: ctx.swellLocation || null,
      ...(entry.id ? { entry_id: entry.id } : {}),
    });
    outcome.changed += 1;
  });
}

/** Steps that an earlier run wrote down and did not finish */
async function repeat(ctx: StockContext, links: Link[], outcome: Outcome): Promise<void> {
  // A step decided for another Swell location would change this one's stock
  const moved = links.filter((link) => ((link.step as Step).swell_location ?? null) !== (ctx.swellLocation || null));
  for (const link of moved) {
    await stop(
      ctx,
      link,
      "The Swell stock location set under Inventory changed while a change of this item was being passed on. Start the item again and say which side has the right quantity.",
      outcome,
    );
  }
  links = links.filter((link) => !moved.includes(link));
  if (links.length === 0) {
    return;
  }
  const oldest = Math.min(...links.map((link) => new Date(link.step.date).getTime()));
  const recorded = await retrieveAdjustments(
    ctx.api,
    links.map((link) => link.variation_id),
    ctx.locationId,
    new Date(oldest - 60 * 1000).toISOString(),
    100,
  );
  if (!recorded.complete) {
    // Sending again without knowing could count the change twice
    throw new Error("Square has more stock changes since the interrupted step than could be read.");
  }
  const references = new Set(recorded.adjustments.map((adjustment) => adjustment.reference_id || ""));
  const work: Work[] = links.map((link) => {
    const step = link.step as Step;
    // Square has the change already when it knows one of the step's references
    const sent = step.parts.some((_, index) => references.has(`${reference(link, step.seq)}:${index}`));
    return { link, step, sent };
  });
  await finish(ctx, work, outcome);
}

async function compare(ctx: StockContext, links: Link[], outcome: Outcome): Promise<void> {
  if (links.length === 0) {
    return;
  }
  // The mark is taken off before the quantities are read: a notice that arrives from now on
  // announces a change this read may not have seen, and stays for the next sync
  const marked = links.filter((link) => link.marked === true);
  await each(marked, (link) => save(ctx.swell, link, { marked: false }));
  const read = new Date().toISOString();
  let levels: Map<string, number>;
  let counts: Map<string, string>;
  try {
    [levels, counts] = await Promise.all([
      readSwellLevels(ctx, links),
      retrieveCounts(
        ctx.api,
        links.map((link) => link.variation_id),
        ctx.locationId,
      ),
    ]);
  } catch (err) {
    // Nothing was read: the marks go back on, for the sync that comes after the trouble
    await each(marked, (link) => save(ctx.swell, link, { marked: true }));
    throw err;
  }

  const changed: { link: Link; swell: number; square: number; agreed: number; starting: boolean }[] = [];
  for (const link of links) {
    outcome.checked += 1;
    const swell = levels.get(link.id);
    if (swell === undefined) {
      await stop(ctx, link, "The Swell product or variant no longer exists.", outcome);
      continue;
    }
    const starting = link.agreed === null || link.agreed === undefined;
    if (!starting && (link.swell_location || null) !== (ctx.swellLocation || null)) {
      // Another location holds another quantity: taking it for a change would move the difference to Square
      await stop(ctx, link, "The Swell stock location set under Inventory has changed since this item was started. Start the item again and say which side has the right quantity.", outcome);
      continue;
    }
    const counted = counts.get(link.variation_id);
    let square = wholeQuantity(counted);
    if (counted === undefined && ((starting && link.start === "swell") || link.agreed === 0)) {
      // Never counted in Square: the first count is what Swell has. A pair started at zero
      // stays uncounted until a change is sent, and reading zero for it gives Swell nothing
      square = 0;
    }
    if (counted === undefined && square === undefined) {
      // A missing count is not zero
      await stop(ctx, link, "Square has no stock count for this item at the location. Count it in Square or turn on its stock tracking, then start the item again.", outcome);
      continue;
    }
    if (square === undefined) {
      await stop(ctx, link, `Square counts ${counted} of this item. Only whole quantities can be shared with Swell.`, outcome);
      continue;
    }
    const agreed = starting ? startingPoint(link.start === "swell" ? "swell" : "square", swell, square) : (link.agreed as number);
    const planned = plan(agreed, swell, square);
    if (planned.toSquare === 0 && planned.toSwell === 0) {
      if (starting || link.swell_level !== swell || link.square_level !== square || link.start) {
        await save(ctx.swell, link, {
          agreed: planned.agreed,
          swell_level: swell,
          square_level: square,
          oversold: planned.agreed < 0,
          start: null,
          date_read: read,
          swell_location: ctx.swellLocation || null,
        });
      }
      continue;
    }
    changed.push({ link, swell, square, agreed, starting });
  }
  if (changed.length === 0) {
    return;
  }

  // What happened on each side, for the words the other side gets
  const toSwell = changed.filter((item) => !item.starting && item.square !== item.agreed);
  let adjustments: Adjustment[] = [];
  if (toSwell.length > 0) {
    const since = toSwell.map((item) => new Date(item.link.date_read || read).getTime());
    try {
      adjustments = (
        await retrieveAdjustments(
          ctx.api,
          toSwell.map((item) => item.link.variation_id),
          ctx.locationId,
          new Date(Math.min(...since)).toISOString(),
          3,
        )
      ).adjustments;
    } catch (err) {
      // Only the wording depends on it
      if (!(err instanceof SquareError) || err.kind === "credentials") {
        throw err;
      }
    }
  }

  const work: Work[] = [];
  await each(changed, async ({ link, swell, square, agreed, starting }) => {
    const planned = plan(agreed, swell, square);
    const entries = planned.toSquare !== 0 && !starting ? await entriesSince(ctx, link) : [];
    const own = adjustments.filter(
      (adjustment) => adjustment.catalog_object_id === link.variation_id && (adjustment.occurred_at || "") > (link.date_read || ""),
    );
    const words = starting
      ? { reason: (planned.toSwell > 0 ? "received" : "missing") as SwellReason, message: "Square POS: starting stock taken from Square" }
      : swellEntry(planned.toSwell, own, `swell:${link.id}:`);
    const step: Step = {
      seq: (link.seq || 0) + 1,
      date: new Date().toISOString(),
      to_square: planned.toSquare,
      to_swell: planned.toSwell,
      agreed: planned.agreed,
      parts: squareParts(planned.toSquare, entries),
      reason: words.reason,
      message: words.message,
      read,
      swell_location: ctx.swellLocation || null,
    };
    await save(ctx.swell, link, { step, seq: step.seq, pending: true });
    work.push({ link, step, sent: false });
  });
  await finish(ctx, work, outcome);
}

/**
 * Syncs the given pairs. Pairs it has no time for are left as they are and counted in `left`.
 */
export async function syncLinks(ctx: StockContext, links: Link[]): Promise<Outcome> {
  const outcome: Outcome = { checked: 0, changed: 0, stopped: 0, left: 0 };
  for (let from = 0; from < links.length; from += CHUNK) {
    if (Date.now() > ctx.deadline) {
      outcome.left = links.length - from;
      break;
    }
    const chunk = links.slice(from, from + CHUNK);
    await repeat(
      ctx,
      chunk.filter((link) => link.step),
      outcome,
    );
    await compare(
      ctx,
      chunk.filter((link) => !link.step && link.status === "active"),
      outcome,
    );
  }
  return outcome;
}
