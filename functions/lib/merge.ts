/**
 * The stock merge. Nothing here talks to Swell or to Square: these functions decide, from
 * numbers, what each side has to receive.
 *
 * A linked pair remembers `agreed`: the quantity both sides held when the last sync ended.
 * Whatever Swell holds beyond it is what Swell did since, and goes to Square; whatever
 * Square holds beyond it goes to Swell. Only these differences travel, never a total, so
 * two sales at the same moment both count.
 */

import type { Adjustment, AdjustmentInput } from "./square";

/** Square's quantity text as a whole number. Undefined for a fraction or for no number at all */
export function wholeQuantity(text: string | undefined | null): number | undefined {
  if (typeof text !== "string" || !/^-?\d+(\.\d+)?$/.test(text.trim())) {
    return undefined;
  }
  const value = Number(text);
  return Number.isInteger(value) && Number.isSafeInteger(value) ? value : undefined;
}

export interface Plan {
  /** Added to Square's count (negative: taken off) */
  toSquare: number;
  /** Added to Swell's stock */
  toSwell: number;
  /** What both sides hold afterwards */
  agreed: number;
}

export function plan(agreed: number, swell: number, square: number): Plan {
  const toSquare = swell - agreed;
  const toSwell = square - agreed;
  return { toSquare, toSwell, agreed: agreed + toSquare + toSwell };
}

/**
 * The first sync of a pair is the one time a side wins: the other side receives the
 * difference. Taking the losing side's quantity as "agreed" makes the ordinary merge do that.
 */
export function startingPoint(winner: "square" | "swell", swell: number, square: number): number {
  return winner === "square" ? swell : square;
}

/* Swell → Square */

export interface StockEntry {
  id?: string;
  quantity?: number;
  reason?: string | null;
}

export interface SquarePart {
  from_state: string;
  to_state: string;
  quantity: number;
}

const RECEIVED: Pick<SquarePart, "from_state" | "to_state"> = { from_state: "NONE", to_state: "IN_STOCK" };
const SOLD: Pick<SquarePart, "from_state" | "to_state"> = { from_state: "IN_STOCK", to_state: "SOLD" };
const WASTE: Pick<SquarePart, "from_state" | "to_state"> = { from_state: "IN_STOCK", to_state: "WASTE" };
const REMOVED: Pick<SquarePart, "from_state" | "to_state"> = { from_state: "IN_STOCK", to_state: "NONE" };

/**
 * How a change of Swell's stock is told to Square. Square keeps reasons apart: sold, lost,
 * received. When Swell's stock entries since the last sync add up to the difference, each
 * kind is sent as what it was. When they do not (the first sync of a pair, or an entry that
 * belongs to the next sync), the difference is sent as one adjustment that claims no
 * reason: received stock, or stock removed.
 */
export function squareParts(difference: number, entries: StockEntry[]): SquarePart[] {
  if (difference === 0) {
    return [];
  }
  const sum = entries.reduce((total, entry) => total + (entry.quantity || 0), 0);
  if (entries.length > 0 && sum === difference) {
    // A canceled or returned sale gives back what "sold" took, in the same sync or a later one
    let sold = 0;
    let lost = 0;
    let received = 0;
    for (const entry of entries) {
      const quantity = entry.quantity || 0;
      if (quantity < 0 && entry.reason === "sold") {
        sold -= quantity;
      } else if (quantity < 0) {
        lost -= quantity;
      } else {
        received += quantity;
      }
    }
    const parts: SquarePart[] = [];
    if (received > 0) {
      parts.push({ ...RECEIVED, quantity: received });
    }
    if (sold > 0) {
      parts.push({ ...SOLD, quantity: sold });
    }
    if (lost > 0) {
      parts.push({ ...WASTE, quantity: lost });
    }
    return parts;
  }
  return difference > 0 ? [{ ...RECEIVED, quantity: difference }] : [{ ...REMOVED, quantity: -difference }];
}

/** The parts as Square adjustments. The reference names the step, so a repeated step is recognised */
export function squareAdjustments(reference: string, variationId: string, parts: SquarePart[]): AdjustmentInput[] {
  return parts.map((part, index) => ({
    reference_id: `${reference}:${index}`,
    catalog_object_id: variationId,
    from_state: part.from_state,
    to_state: part.to_state,
    quantity: part.quantity,
  }));
}

/* Square → Swell */

export type SwellReason = "received" | "returned" | "sold" | "missing" | "damaged";

export interface SwellEntry {
  reason: SwellReason;
  message: string;
}

/** What an adjustment did to the quantity for sale, and what to call it */
function effect(adjustment: Adjustment): { change: number; kind: string } | undefined {
  const quantity = wholeQuantity(adjustment.quantity);
  if (quantity === undefined) {
    return undefined;
  }
  if (adjustment.to_state === "IN_STOCK" && adjustment.from_state !== "IN_STOCK") {
    if (adjustment.physical_count_id) {
      return { change: quantity, kind: "recount" };
    }
    const returned = adjustment.from_state === "RETURNED_BY_CUSTOMER" || adjustment.from_state === "UNLINKED_RETURN" || adjustment.from_state === "SOLD";
    return { change: quantity, kind: returned ? "returned" : "received" };
  }
  if (adjustment.from_state === "IN_STOCK" && adjustment.to_state !== "IN_STOCK") {
    if (adjustment.physical_count_id) {
      return { change: -quantity, kind: "recount" };
    }
    if (adjustment.to_state === "SOLD") {
      return { change: -quantity, kind: "sold" };
    }
    if (adjustment.to_state === "WASTE") {
      return { change: -quantity, kind: "damaged" };
    }
    return { change: -quantity, kind: "removed" };
  }
  return undefined;
}

const WORDS: Record<string, string> = {
  sold: "sold",
  returned: "returned",
  received: "received",
  damaged: "damaged or lost",
  removed: "removed",
};

/**
 * The reason and the text of the Swell stock entry for a change that came from Square.
 * Square's count does not say what changed it, so its recent adjustments are read: when
 * they add up to the difference, the entry says what happened. Otherwise it only says
 * where the change came from.
 */
export function swellEntry(difference: number, adjustments: Adjustment[], ownReference: string): SwellEntry {
  const fallback: SwellEntry = {
    reason: difference > 0 ? "received" : "missing",
    message: "Square POS: stock changed in Square",
  };
  const kinds = new Map<string, number>();
  let sum = 0;
  for (const adjustment of adjustments) {
    // The app's own adjustments are Swell's changes, not Square's
    if ((adjustment.reference_id || "").startsWith(ownReference)) {
      continue;
    }
    const found = effect(adjustment);
    if (!found) {
      continue;
    }
    sum += found.change;
    kinds.set(found.kind, (kinds.get(found.kind) || 0) + found.change);
  }
  if (kinds.size === 0 || sum !== difference) {
    return fallback;
  }

  const parts = [...kinds.entries()].filter(([, change]) => change !== 0);
  if (parts.length === 0) {
    return fallback;
  }
  // The kind that moved the most stock in the direction of the difference names the entry
  const [main] = parts
    .filter(([, change]) => Math.sign(change) === Math.sign(difference))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0] || [undefined];
  const reasons: Record<string, SwellReason> = {
    sold: "sold",
    returned: "returned",
    received: "received",
    damaged: "damaged",
    removed: "missing",
    recount: difference > 0 ? "received" : "missing",
  };
  const text = parts
    .map(([kind, change]) => `${Math.abs(change)} ${kind === "recount" ? (change > 0 ? "added by a recount" : "removed by a recount") : WORDS[kind]}`)
    .join(", ");
  return {
    reason: (main && reasons[main]) || fallback.reason,
    message: `Square POS: ${text}`,
  };
}
