/**
 * A Square order as a Swell order. Nothing here talks to Swell or to Square.
 *
 * The Swell order copies the receipt: every amount is one that Square charged, and the
 * total is checked against Square's before anything is written. Lines carry names and
 * amounts but no product, so the order can neither take stock (the stock sync does that)
 * nor fail on a product.
 */

import { wholeQuantity } from "./merge";

type Sq = Record<string, any>;

/* Money: Square counts in the smallest unit of the currency, Swell in decimals */

export function decimals(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function toAmount(minor: number, currency: string): number {
  const digits = decimals(currency);
  return Number((minor / 10 ** digits).toFixed(digits));
}

function minor(money: Sq | undefined | null): number {
  return typeof money?.amount === "number" ? money.amount : 0;
}

/* What kind of Square order it is */

export type Kind =
  /** A sale: becomes an order */
  | "sale"
  /** The order Square creates for a refund: it has no lines of its own and points at the sale */
  | "refund"
  /** A sale with returned items in one order */
  | "exchange"
  /** Not completed, or nothing in it */
  | "other";

export function kindOf(order: Sq): Kind {
  if (order.state !== "COMPLETED") {
    return "other";
  }
  const lines = (order.line_items || []).length > 0;
  const returns = (order.returns || []).length > 0;
  if (lines && returns) {
    return "exchange";
  }
  if (returns) {
    return "refund";
  }
  return lines || (order.tenders || []).length > 0 ? "sale" : "other";
}

/* How the sale was taken and paid */

const PRODUCTS: Record<string, string> = {
  SQUARE_POS: "Square Point of Sale",
  RETAIL: "Square for Retail",
  RESTAURANTS: "Square for Restaurants",
  APPOINTMENTS: "Square Appointments",
  INVOICES: "Square Invoices",
  ONLINE_STORE: "Square Online",
  VIRTUAL_TERMINAL: "Square Virtual Terminal",
  TERMINAL_API: "Square Terminal",
  DASHBOARD: "Square Dashboard",
  ECOMMERCE_API: "An online checkout (Square API)",
};

function words(text: string): string {
  const lower = text.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function tenderText(order: Sq): string {
  const parts = (order.tenders || []).map((tender: Sq) => {
    if (tender.type === "CARD") {
      const card = tender.card_details?.card || {};
      const detail = [card.card_brand && words(card.card_brand), card.last_4].filter(Boolean).join(" ");
      return detail ? `Card (${detail})` : "Card";
    }
    if (tender.type === "SQUARE_GIFT_CARD") {
      return "Square gift card";
    }
    return words(tender.type || "Other");
  });
  return [...new Set<string>(parts)].join(", ");
}

/** What the sale's record shows, read from the order and from its first payment when there is one */
export function describeSale(order: Sq, payment: Sq | undefined, locationName: string): Record<string, unknown> {
  const currency = order.total_money?.currency || "USD";
  const product: string | undefined = payment?.application_details?.square_product;
  const receipt: string | undefined = payment?.receipt_number;
  return {
    name: receipt ? `Receipt ${receipt}` : `Sale ${String(order.id).slice(0, 8)}`,
    location_id: order.location_id,
    location_name: locationName,
    receipt_number: receipt || null,
    receipt_url: payment?.receipt_url || null,
    source: product ? PRODUCTS[product] || words(product) : order.source?.name || null,
    tender: tenderText(order) || null,
    total: toAmount(minor(order.total_money), currency),
    currency,
    date_sold: order.closed_at || order.created_at || null,
  };
}

/**
 * True for a sale that an application took through Square's payment API: an online
 * checkout that uses Square as its payment provider. It is not a sale of the shop, and
 * when that checkout is this store's own, importing it would create the order twice.
 */
export function takenByApi(payment: Sq | undefined): boolean {
  return payment?.application_details?.square_product === "ECOMMERCE_API";
}

/* The order */

export interface OrderContext {
  appId: string;
  /** The Swell order's id and number, both derived from the Square order */
  id: string;
  number: string;
  accountId: string;
  locationName: string;
  payment?: Sq;
  /** Lets the store record the order's events, for webhooks and other apps */
  announce: boolean;
  /** What Square has refunded on the sale so far */
  refunded?: number;
}

export type Built = { order: Record<string, any>; totalMinor: number } | { problem: string };

interface Line {
  description: string;
  product_name: string;
  variant_name?: string;
  quantity: number;
  /** Per unit, smallest unit of the currency */
  price: number;
  discounts: { id: string; amount: number }[];
  taxes: { id: string; amount: number }[];
  metadata?: Record<string, unknown>;
}

function lineName(line: Sq): string {
  const name = (line.name || "").trim() || "Custom amount";
  const variation = (line.variation_name || "").trim();
  const modifiers = (line.modifiers || []).map((modifier: Sq) => (modifier.name || "").trim()).filter(Boolean);
  return [variation && variation !== "Regular" ? `${name} – ${variation}` : name, ...modifiers].join(", ");
}

export function buildOrder(order: Sq, context: OrderContext): Built {
  const currency: string = order.total_money?.currency;
  if (!currency) {
    return { problem: "The Square order has no total." };
  }
  const total = minor(order.total_money);
  if (total < 0) {
    return { problem: "The Square order has a negative total." };
  }

  // A tax that is part of the prices adds nothing to the total; one that comes on top does.
  // A Swell order treats all its taxes one way or the other
  const taxKinds = new Map<string, string>((order.taxes || []).map((tax: Sq) => [tax.uid, tax.type || "ADDITIVE"]));
  const kinds = new Set(taxKinds.values());
  const included = kinds.size === 1 && kinds.has("INCLUSIVE");
  const counts = (taxUid: string) => included || taxKinds.get(taxUid) !== "INCLUSIVE";

  const taxesOf = (applied: Sq[] | undefined) =>
    (applied || [])
      .filter((tax) => counts(tax.tax_uid) && minor(tax.applied_money) !== 0)
      .map((tax) => ({ id: `square-${tax.tax_uid}`, amount: minor(tax.applied_money) }));

  const lines: Line[] = [];
  for (const item of (order.line_items || []) as Sq[]) {
    const gross = minor(item.gross_sales_money);
    const quantity = wholeQuantity(item.quantity);
    const name = lineName(item);
    // Swell multiplies a unit price by a whole quantity. Where that cannot give Square's
    // amount (a weight, or a price that does not divide), the line is one unit of the amount
    const divides = quantity !== undefined && quantity >= 1 && gross % quantity === 0;
    const applied = ((item.applied_discounts || []) as Sq[])
      .filter((discount) => minor(discount.applied_money) !== 0)
      .map((discount) => ({ id: `square-${discount.discount_uid}`, amount: minor(discount.applied_money) }));
    const discounted = minor(item.total_discount_money);
    lines.push({
      description: divides ? name : `${item.quantity} × ${name}`,
      product_name: (item.name || "").trim() || "Custom amount",
      ...(item.variation_name && item.variation_name !== "Regular" && divides ? { variant_name: item.variation_name } : {}),
      quantity: divides ? quantity : 1,
      price: divides ? gross / quantity : gross,
      discounts: applied.reduce((sum, discount) => sum + discount.amount, 0) === discounted ? applied : [{ id: "square-discount", amount: discounted }].filter((discount) => discount.amount !== 0),
      taxes: taxesOf(item.applied_taxes),
      metadata: {
        ...(item.catalog_object_id ? { square_variation_id: item.catalog_object_id } : {}),
        ...(item.note ? { note: item.note } : {}),
      },
    });
  }

  for (const charge of (order.service_charges || []) as Sq[]) {
    const amount = minor(charge.applied_money) || minor(charge.amount_money);
    if (amount === 0) {
      continue;
    }
    const name = (charge.name || "").trim() || "Service charge";
    lines.push({ description: name, product_name: name, quantity: 1, price: amount, discounts: [], taxes: taxesOf(charge.applied_taxes) });
  }
  if (minor(order.total_tip_money) > 0) {
    lines.push({ description: "Tip", product_name: "Tip", quantity: 1, price: minor(order.total_tip_money), discounts: [], taxes: [] });
  }
  // Cash totals rounded to the coins that exist (5 cents, for example)
  const rounding = minor(order.rounding_adjustment?.amount_money);
  if (rounding > 0) {
    lines.push({ description: "Rounding", product_name: "Rounding", quantity: 1, price: rounding, discounts: [], taxes: [] });
  } else if (rounding < 0) {
    const largest = [...lines].sort((a, b) => b.price * b.quantity - a.price * a.quantity)[0];
    if (largest) {
      largest.discounts.push({ id: "square-rounding", amount: -rounding });
    }
  }

  const sum = (line: Line) =>
    line.price * line.quantity -
    line.discounts.reduce((all, discount) => all + discount.amount, 0) +
    (included ? 0 : line.taxes.reduce((all, tax) => all + tax.amount, 0));
  let computed = lines.reduce((all, line) => all + sum(line), 0);

  // A surcharge for paying by card is counted in the total but is no line of the order
  const surcharge = minor(order.total_card_surcharge_money);
  if (surcharge > 0 && computed + surcharge === total) {
    lines.push({ description: "Card surcharge", product_name: "Card surcharge", quantity: 1, price: surcharge, discounts: [], taxes: [] });
    computed += surcharge;
  }
  if (lines.length === 0) {
    return { problem: "The Square order has no lines." };
  }
  if (computed !== total) {
    const text = (value: number) => `${toAmount(value, currency).toFixed(decimals(currency))} ${currency}`;
    return { problem: `The lines of the Square order add up to ${text(computed)}, but its total is ${text(total)}. It is not imported, so that no order differs from its receipt.` };
  }

  const money = (value: number) => toAmount(value, currency);
  const taxes = ((order.taxes || []) as Sq[])
    .filter((tax) => counts(tax.uid))
    .map((tax) => ({
      id: `square-${tax.uid}`,
      name: tax.name || "Tax",
      ...(Number.isFinite(Number(tax.percentage)) && tax.percentage !== undefined ? { rate: Number(tax.percentage) } : {}),
      amount: money(minor(tax.applied_money)),
    }));
  const discountIds = new Set(lines.flatMap((line) => line.discounts.map((discount) => discount.id)));
  const discounts = [...discountIds].map((id) => ({
    id,
    type: "sale",
    amount: money(lines.reduce((all, line) => all + line.discounts.filter((discount) => discount.id === id).reduce((part, discount) => part + discount.amount, 0), 0)),
  }));

  const payment = context.payment;
  const names = ((order.discounts || []) as Sq[]).map((discount) => (discount.name || "").trim()).filter(Boolean);
  const comments = [
    `Sold in Square at ${context.locationName}${payment?.receipt_number ? `, receipt ${payment.receipt_number}` : ""}.`,
    tenderText(order) ? `Paid with: ${tenderText(order)}.` : "",
    names.length > 0 ? `Discounts: ${names.join(", ")}.` : "",
    order.ticket_name ? `Ticket: ${order.ticket_name}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    totalMinor: total,
    order: {
      id: context.id,
      number: context.number,
      date_created: order.closed_at || order.created_at,
      account_id: context.accountId,
      // Neither the account's address and card are copied to the order, nor the other way round
      account_info_saved: false,
      account_logged_in: false,
      currency,
      items: lines.map((line) => ({
        description: line.description,
        product_name: line.product_name,
        ...(line.variant_name ? { variant_name: line.variant_name } : {}),
        quantity: line.quantity,
        price: money(line.price),
        ...(line.discounts.length > 0 ? { discounts: line.discounts.map((discount) => ({ id: discount.id, amount: money(discount.amount) })) } : {}),
        ...(line.taxes.length > 0 ? { taxes: line.taxes.map((tax) => ({ id: tax.id, amount: money(tax.amount) })) } : {}),
        ...(line.metadata && Object.keys(line.metadata).length > 0 ? { metadata: line.metadata } : {}),
      })),
      // The amounts are Square's: the store's own tax rules and promotions stay out of it
      taxes_fixed: true,
      taxes,
      discounts,
      item_tax_included: included,
      comments,
      $app: {
        [context.appId]: {
          square_order_id: order.id,
          receipt_number: payment?.receipt_number || null,
          receipt_url: payment?.receipt_url || null,
          location_name: context.locationName,
          tender: tenderText(order) || null,
          refunded: context.refunded || 0,
        },
      },
      // No e-mail to the customer or the staff, no charge of a saved card, lines kept apart
      $notify: false,
      $payment: false,
      $combine_items: false,
      // A workflow's writes raise no events unless they ask for them
      ...(context.announce ? { $events: true } : {}),
    },
  };
}

export const PAYMENT_METHOD = "square_pos";

export interface Money {
  /** The Swell payment record's id, derived from the Square payment */
  id: string;
  tender_id: string;
  amount: number;
  date: string;
}

/**
 * The payments Square took for a sale, one per tender, as Swell payment records will hold
 * them. When the tenders do not add up to the total (a tip added afterwards, for example),
 * the sale is one payment of its total.
 */
export async function salePayments(order: Sq, recordIdOf: (text: string) => Promise<string>): Promise<Money[]> {
  const currency: string = order.total_money?.currency || "USD";
  const total = minor(order.total_money);
  if (total === 0) {
    return [];
  }
  const date: string = order.closed_at || order.created_at;
  const tenders = ((order.tenders || []) as Sq[]).filter((tender) => tender.id && minor(tender.amount_money) > 0);
  // A tender's amount includes its tip
  const sum = tenders.reduce((all, tender) => all + minor(tender.amount_money), 0);
  if (tenders.length > 0 && sum === total) {
    return Promise.all(
      tenders.map(async (tender) => ({
        id: await recordIdOf(`square-tender:${tender.id}`),
        tender_id: tender.id as string,
        amount: toAmount(minor(tender.amount_money), currency),
        date,
      })),
    );
  }
  const tender: string = tenders[0]?.id || order.id;
  return [{ id: await recordIdOf(`square-tender:${tender}`), tender_id: tender, amount: toAmount(total, currency), date }];
}

/** What Swell says the order's total is, in the smallest unit: compared with Square's after the order is created */
export function totalMinor(grandTotal: unknown, currency: string): number {
  return Math.round(Number(grandTotal || 0) * 10 ** decimals(currency));
}

/* Refunds */

export interface Refund {
  id: string;
  /** The Square payment it pays back (a tender of the sale) */
  tender_id?: string | null;
  amount: number;
  reason?: string | null;
  date?: string | null;
}

/**
 * The refunds a Square refund order records, by the sale they belong to. A refund that
 * Square rejected or that failed is left out; a pending one counts, since the till has
 * handed the money back.
 */
export function refundsBySale(order: Sq): Map<string, Refund[]> {
  const currency: string = order.return_amounts?.total_money?.currency || order.net_amounts?.total_money?.currency || "USD";
  const sources: string[] = [...new Set<string>(((order.returns || []) as Sq[]).map((entry) => entry.source_order_id).filter(Boolean))];
  const bySale = new Map<string, Refund[]>();
  for (const refund of (order.refunds || []) as Sq[]) {
    if (refund.status === "REJECTED" || refund.status === "FAILED") {
      continue;
    }
    // A refund names the sale it pays back. One without it belongs to the order's only return
    const sale: string | undefined = sources.includes(refund.transaction_id) ? refund.transaction_id : sources.length === 1 ? sources[0] : undefined;
    if (!sale || !refund.id) {
      continue;
    }
    const list = bySale.get(sale) || [];
    list.push({
      id: refund.id,
      tender_id: refund.tender_id || null,
      amount: toAmount(minor(refund.amount_money), refund.amount_money?.currency || currency),
      reason: refund.reason || null,
      date: refund.created_at || null,
    });
    bySale.set(sale, list);
  }
  return bySale;
}

/**
 * A refund as Square's payment API answers it. A payment names its refunds as its own id,
 * an underscore, and the id the refund has on a refund order: the latter is kept, so a
 * refund found both ways is counted once.
 */
export function refundOfPayment(refund: Sq): Refund | undefined {
  if (!refund?.id || refund.status === "REJECTED" || refund.status === "FAILED") {
    return undefined;
  }
  const id: string = refund.payment_id && String(refund.id).startsWith(`${refund.payment_id}_`) ? String(refund.id).slice(refund.payment_id.length + 1) : refund.id;
  return {
    id,
    tender_id: refund.payment_id || null,
    amount: toAmount(minor(refund.amount_money), refund.amount_money?.currency || "USD"),
    reason: refund.reason || null,
    date: refund.created_at || null,
  };
}

/** Adds refunds to the ones a sale already has. Returns undefined when there is nothing new */
export function mergeRefunds(existing: Refund[] | undefined | null, found: Refund[], total: number): { refunds: Refund[]; refunded: number; refund_state: "partial" | "full" } | undefined {
  const refunds = [...(existing || [])];
  let changed = false;
  for (const refund of found) {
    if (!refunds.some((known) => known.id === refund.id)) {
      refunds.push(refund);
      changed = true;
    }
  }
  if (!changed) {
    return undefined;
  }
  const refunded = Number(refunds.reduce((sum, refund) => sum + (refund.amount || 0), 0).toFixed(4));
  return { refunds, refunded, refund_state: refunded >= total && total > 0 ? "full" : "partial" };
}
