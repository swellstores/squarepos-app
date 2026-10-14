/**
 * The import of Square sales as Swell orders, and of refunds onto them.
 *
 * Every Square order the app comes across gets a record in the app's `sales` collection
 * under a unique key, before anything is created in Swell. The record is what makes a sale
 * imported once, and where a sale that cannot be imported is listed with the reason.
 */

import { recordId, timedId } from "./ids";
import { PAYMENT_METHOD, buildOrder, decimals, describeSale, kindOf, mergeRefunds, refundOfPayment, refundsBySale, salePayments, takenByApi, totalMinor } from "./order";
import type { Money, Refund } from "./order";
import { isDuplicate, writeErrors } from "./settings";
import type { Page, StoreClient } from "./settings";
import { SquareError, retrieveCustomer, retrieveOrder, retrievePayment, retrieveRefund, searchOrders } from "./square";
import type { Api } from "./square";

type Row = Record<string, any>;
export type Sale = Row & { id: string; key: string };

export interface SalesContext {
  swell: StoreClient;
  api: Api;
  appId: string;
  /** The Square locations whose sales are imported, with their names */
  locations: { id: string; name: string }[];
  /** Lets the store record the orders' events, for webhooks and other apps */
  announce: boolean;
  /** Time (ms) after which no further sale is started */
  deadline: number;
  /** Sales completed earlier are not imported: the import was switched on, or past sales asked for, from then */
  from?: string;
  /** The account for sales without a known customer, once it was looked up */
  walkInId?: string;
}

export const WALK_IN_EMAIL = "walk-in@square-pos.invalid";
const WALK_IN_NAME = "Walk-in customer";

/** A sale that Square could not be asked about is tried again this often before it is listed */
const MAX_ATTEMPTS = 5;

function locationName(ctx: SalesContext, locationId: string): string {
  return ctx.locations.find((location) => location.id === locationId)?.name || locationId;
}

async function findSale(swell: StoreClient, key: string): Promise<Sale | undefined> {
  const found = (await swell.get("/sales", { where: { key }, limit: 1 })) as Page<Sale>;
  return found?.results?.[0];
}

async function saveSale(swell: StoreClient, sale: Sale, values: Row): Promise<void> {
  const result = await swell.put(`/sales/${sale.id}`, values);
  const errors = writeErrors(result);
  if (errors) {
    throw new Error(`Unable to save the sale ${sale.key}: ${errors}`);
  }
  Object.assign(sale, values);
}

/** The sale's record, created as waiting when it is new. Two creates at once end with one record */
async function claimSale(swell: StoreClient, key: string, values: Row): Promise<{ sale: Sale; created: boolean }> {
  const existing = await findSale(swell, key);
  if (existing) {
    return { sale: existing, created: false };
  }
  let created: unknown;
  try {
    created = await swell.post("/sales", { key, status: "pending", ...values });
  } catch (err) {
    if (!isDuplicate(undefined, err)) {
      throw err;
    }
  }
  if (created && !writeErrors(created)) {
    return { sale: created as Sale, created: true };
  }
  const other = await findSale(swell, key);
  if (!other) {
    throw new Error(`Unable to record the sale ${key}: ${writeErrors(created) || "no record"}`);
  }
  return { sale: other, created: false };
}

/* Money: the payments and refunds of a sale, as Swell payment records */

function event(ctx: SalesContext): Row {
  return { $notify: false, ...(ctx.announce ? { $events: true } : {}) };
}

/**
 * Records the sale's payments on its order, under the Square POS payment method. Each record
 * has an id derived from the Square payment, so recording twice changes nothing.
 */
async function recordPayments(ctx: SalesContext, orderId: string, payments: Money[]): Promise<string | undefined> {
  for (const payment of payments) {
    const result = await ctx.swell.post("/payments", {
      id: payment.id,
      order_id: orderId,
      method: PAYMENT_METHOD,
      amount: payment.amount,
      transaction_id: payment.tender_id,
      date_created: payment.date,
      ...event(ctx),
    });
    const errors = writeErrors(result);
    if (errors) {
      return /method/.test(errors)
        ? `Swell has no payment method "Square POS" to record the payment with. Press Test connection in the app's settings, which adds it. (${errors})`
        : `Swell did not record the payment. ${errors}`;
    }
  }
  return undefined;
}

/**
 * Records each refund on the payment it pays back: the one of its Square tender, or the
 * order's first when the sale was recorded as one payment. Repeated, nothing doubles.
 * Returns a problem when one cannot be recorded.
 */
async function recordRefunds(ctx: SalesContext, orderId: string, refunds: Refund[]): Promise<string | undefined> {
  let first: string | undefined;
  for (const refund of refunds) {
    const id = await recordId(`square-refund:${refund.id}`);
    let paymentId = refund.tender_id ? await recordId(`square-tender:${refund.tender_id}`) : undefined;
    if (!paymentId || !(await ctx.swell.get(`/payments/${paymentId}`, { fields: "id" }))) {
      first ||= ((await ctx.swell.get("/payments", { where: { order_id: orderId }, sort: "date_created asc", limit: 1 })) as Page)?.results?.[0]?.id;
      paymentId = first;
    }
    if (!paymentId) {
      return `Swell did not record the refund of ${refund.amount}. The order has no payment to refund.`;
    }
    // Recorded before: the store refuses the same refund again once the payment is refunded in full
    if (await ctx.swell.get(`/payments/${paymentId}/refunds/${id}`)) {
      continue;
    }
    const result = await ctx.swell.post(`/payments/${paymentId}/refunds`, {
      id,
      amount: refund.amount,
      reason: refund.reason || "Refunded in Square",
      transaction_id: refund.id,
      ...(refund.date ? { date_created: refund.date } : {}),
      ...event(ctx),
    });
    const errors = writeErrors(result);
    if (errors || !result) {
      return `Swell did not record the refund of ${refund.amount}. ${errors || "No refund was returned."}`;
    }
  }
  return undefined;
}

/** Records the refunds of a Square refund order on the sales they pay back. Returns how many sales changed, and how many of them failed */
export async function applyRefunds(ctx: SalesContext, order: Row): Promise<{ changed: number; failed: number }> {
  let changed = 0;
  let failed = 0;
  for (const [saleKey, refunds] of refundsBySale(order)) {
    const sale = await findSale(ctx.swell, saleKey);
    if (!sale) {
      // A sale from before the import was switched on
      continue;
    }
    const merged = mergeRefunds(sale.refunds as Refund[], refunds, sale.total || 0);
    if (!merged) {
      continue;
    }
    // The order gets the refunds before the sale says it has them: when this is cut short,
    // the next search finds them new again. A sale without an order gets them at its import
    const problem = sale.order_id ? await recordRefunds(ctx, sale.order_id, refunds) : undefined;
    if (sale.order_id && !problem) {
      const noted = await ctx.swell.put(`/orders/${sale.order_id}`, { $app: { [ctx.appId]: { refunded: merged.refunded } }, ...event(ctx) });
      if (writeErrors(noted)) {
        console.error("Unable to note the refunded amount on the order", writeErrors(noted));
      }
    }
    // A refund the store refuses lists the sale; Retry records it once the cause is gone
    await saveSale(ctx.swell, sale, { ...merged, ...(problem ? { status: "failed", problem } : {}) });
    changed += 1;
    failed += problem ? 1 : 0;
  }
  return { changed, failed };
}

/* Finding sales */

export interface Found {
  /** Sales recorded as waiting for their import */
  sales: number;
  refunds: number;
  /** Sales whose refunds the store refused: listed under Needs attention */
  failed: number;
  /** Square's cursor to the next page */
  cursor?: string;
}

/** True for a sale completed before a time. An old sale is found again when Square changes it, by a refund for example */
function before(order: Row, from: string | undefined): boolean {
  const sold = new Date(order.closed_at || order.created_at || "").getTime();
  return Boolean(from) && sold < new Date(from as string).getTime();
}

/** Reads one page of the completed orders of up to ten locations changed in a time range, and records what it finds */
export async function findSales(ctx: SalesContext, locationIds: string[], from: string, until: string, cursor?: string): Promise<Found> {
  const found: Found = { sales: 0, refunds: 0, failed: 0 };
  const page = await searchOrders(ctx.api, locationIds, from, until, cursor);
  for (const order of page.orders) {
    const kind = kindOf(order);
    if (kind === "refund") {
      const applied = await applyRefunds(ctx, order);
      found.refunds += applied.changed;
      found.failed += applied.failed;
    } else if ((kind === "sale" || kind === "exchange") && !before(order, ctx.from)) {
      const { created } = await claimSale(ctx.swell, order.id, describeSale(order, undefined, locationName(ctx, order.location_id)));
      found.sales += created ? 1 : 0;
    }
  }
  found.cursor = page.cursor;
  return found;
}

/* Importing a sale */

async function walkInAccount(ctx: SalesContext): Promise<string> {
  if (ctx.walkInId) {
    return ctx.walkInId;
  }
  const find = async () => ((await ctx.swell.get("/accounts", { where: { email: WALK_IN_EMAIL }, fields: "email", limit: 1 })) as Page)?.results?.[0];
  let account = await find();
  if (!account) {
    let created: unknown;
    try {
      created = await ctx.swell.post("/accounts", {
        email: WALK_IN_EMAIL,
        first_name: "Walk-in",
        last_name: "customer (Square POS)",
        email_optin: false,
        $notify: false,
      });
    } catch (err) {
      if (!isDuplicate(undefined, err)) {
        throw err;
      }
    }
    account = created && !writeErrors(created) ? (created as Row) : await find();
    if (!account) {
      throw new Error(`Unable to create the account for walk-in customers: ${writeErrors(created) || "no record"}`);
    }
  }
  ctx.walkInId = account.id as string;
  return ctx.walkInId;
}

/** The Swell account with the e-mail address of the sale's Square customer, or the walk-in account */
async function accountFor(ctx: SalesContext, order: Row, payment: Row | undefined): Promise<{ id: string; name?: string; email?: string }> {
  const customerId: string | undefined =
    order.customer_id || payment?.customer_id || ((order.tenders || []) as Row[]).map((tender) => tender.customer_id).find(Boolean);
  if (customerId) {
    const customer = await retrieveCustomer(ctx.api, customerId);
    const email = (customer?.email_address || "").trim().toLowerCase();
    const name = [customer?.given_name, customer?.family_name].filter(Boolean).join(" ") || customer?.company_name || undefined;
    if (email) {
      const found = (await ctx.swell.get("/accounts", { where: { email }, fields: "email,name", limit: 1 })) as Page;
      const account = found?.results?.[0];
      if (account) {
        return { id: account.id, name: account.name || name, email };
      }
    }
    return { id: await walkInAccount(ctx), name: name || WALK_IN_NAME, email: email || undefined };
  }
  return { id: await walkInAccount(ctx), name: WALK_IN_NAME };
}

async function fail(ctx: SalesContext, sale: Sale, status: "failed" | "skipped", problem: string, values: Row = {}): Promise<"failed" | "skipped"> {
  await saveSale(ctx.swell, sale, { ...values, status, problem, attempts: (sale.attempts || 0) + 1, date_attempted: new Date().toISOString() });
  return status;
}

export type Imported = "imported" | "failed" | "skipped" | "waiting";

/**
 * Imports one sale. Trouble with the store or with Square's availability is thrown or
 * leaves the sale waiting; everything else ends on the sale's record.
 */
export async function importSale(ctx: SalesContext, sale: Sale): Promise<Imported> {
  let order: Row | undefined;
  let payment: Row | undefined;
  // Refunds made before the sale had its record. Later ones arrive as Square's refund orders
  const earlier: Refund[] = [];
  try {
    order = await retrieveOrder(ctx.api, sale.key);
    const paymentIds = [...new Set<string>(((order?.tenders || []) as Row[]).map((tender) => tender.payment_id || tender.id).filter(Boolean))];
    for (const paymentId of paymentIds.slice(0, 10)) {
      const found = await retrievePayment(ctx.api, paymentId);
      payment = payment || found;
      for (const refundId of ((found?.refund_ids || []) as string[]).slice(0, 20)) {
        const refund = refundOfPayment((await retrieveRefund(ctx.api, refundId)) || {});
        if (refund) {
          earlier.push(refund);
        }
      }
    }
  } catch (err) {
    if (err instanceof SquareError && err.kind === "unavailable") {
      const attempts = (sale.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        return fail(ctx, sale, "failed", `Square could not be asked for this sale. ${err.message}`);
      }
      await saveSale(ctx.swell, sale, { attempts, date_attempted: new Date().toISOString() });
      return "waiting";
    }
    if (err instanceof SquareError && err.kind === "refused") {
      return fail(ctx, sale, "failed", err.message);
    }
    throw err;
  }
  if (!order) {
    return fail(ctx, sale, "failed", "Square no longer has this order.");
  }

  const details = describeSale(order, payment, locationName(ctx, order.location_id));
  const kind = kindOf(order);
  if (kind === "exchange") {
    return fail(ctx, sale, "skipped", "An exchange: a sale with returned items on one receipt. It is not imported. Record it by hand if you need it in Swell.", details);
  }
  if (kind !== "sale") {
    return fail(ctx, sale, "skipped", "The Square order is not a completed sale.", details);
  }
  if (takenByApi(payment) && !ctx.api.sandbox) {
    return fail(ctx, sale, "skipped", "Taken by an online checkout through Square's payment API, not in the shop. Such sales are not imported, since the checkout keeps its own orders.", details);
  }

  const currency = details.currency as string;
  const merged = mergeRefunds(sale.refunds as Refund[], earlier, details.total as number);
  if (merged) {
    await saveSale(ctx.swell, sale, merged);
  }
  const account = await accountFor(ctx, order, payment);
  // Starting with the time of the sale, the order takes its place in the dashboard's list of orders
  const id = (sale.order_id as string | undefined) || (await timedId(order.closed_at || order.created_at, `square-order:${order.id}`));

  // An earlier attempt may have created the order and stopped before the record said so
  let created = (await ctx.swell.get(`/orders/${id}`, { fields: "number,grand_total,currency,account_id" })) as Row | "" | null;
  const fresh = !created;
  if (!created) {
    const number = payment?.receipt_number ? `SQ-${payment.receipt_number}` : `SQ-${String(order.id).slice(0, 8)}`;
    const built = buildOrder(order, {
      appId: ctx.appId,
      id,
      number,
      accountId: account.id,
      locationName: locationName(ctx, order.location_id),
      payment,
      announce: ctx.announce,
      refunded: sale.refunded || 0,
    });
    if ("problem" in built) {
      return fail(ctx, sale, "failed", built.problem, details);
    }
    let result = (await ctx.swell.post("/orders", built.order)) as Row;
    if ((result?.errors as Row | undefined)?.number) {
      // Square's receipt numbers are short and can repeat over the years
      result = (await ctx.swell.post("/orders", { ...built.order, number: `${number}-${String(order.id).slice(0, 4)}` })) as Row;
    }
    const errors = writeErrors(result);
    if (errors || !result?.id) {
      return fail(ctx, sale, "failed", `Swell did not accept the order. ${errors || "No order was returned."}`, details);
    }
    created = result;
  }

  // A currency the store only displays is replaced by its own one, the amounts kept: the
  // order would claim the receipt's numbers in another currency
  const kept = String(created.currency || currency).toUpperCase();
  if (kept !== currency.toUpperCase()) {
    const cause = `Swell records this sale's order in ${kept}, at the amounts of the ${currency} receipt, since ${currency} has no prices of its own in this store.`;
    if (!fresh) {
      // Found from an earlier attempt: it may hold money already, so it is left for the merchant
      return fail(ctx, sale, "failed", `${cause} Correct or delete order ${created.number} by hand, then mark this sale as resolved.`, { ...details, order_id: created.id });
    }
    // Created just now, without a payment. Whoever was told of it is told it is gone
    await ctx.swell.delete(`/orders/${created.id}`, ctx.announce ? { $events: true } : undefined);
    return fail(ctx, sale, "failed", `${cause} It is not imported. Record it by hand, then mark it as resolved.`, { ...details, order_id: null });
  }

  // The money: Square's payments, and what it refunded so far. Repeated, nothing doubles
  const problem =
    (await recordPayments(ctx, created.id as string, await salePayments(order, recordId))) ||
    (await recordRefunds(ctx, created.id as string, (sale.refunds as Refund[]) || []));

  const values: Row = {
    ...details,
    order_id: created.id,
    order_number: created.number,
    account_id: created.account_id || account.id,
    customer_name: account.name || null,
    customer_email: account.email || null,
    square_updated_at: order.updated_at || null,
    attempts: (sale.attempts || 0) + 1,
    date_attempted: new Date().toISOString(),
  };
  if ((sale.refunded || 0) > 0) {
    values.refund_state = (sale.refunded || 0) >= (details.total as number) && (details.total as number) > 0 ? "full" : "partial";
  }
  const expected = totalMinor(details.total, currency);
  if (problem) {
    return fail(ctx, sale, "failed", problem, values);
  }
  if (totalMinor(created.grand_total, currency) !== expected) {
    const digits = decimals(currency);
    return fail(
      ctx,
      sale,
      "failed",
      `Order ${created.number} has a total of ${Number(created.grand_total || 0).toFixed(digits)} ${currency} in Swell, but the Square receipt says ${(details.total as number).toFixed(digits)}. Correct the order by hand, then mark this sale as resolved.`,
      values,
    );
  }
  await saveSale(ctx.swell, sale, { ...values, status: "imported", problem: null });
  return "imported";
}

/**
 * Imports the given sales, as many as there is time for. A sale the store refuses to work
 * on is noted on its record and the others go on; after some attempts it is listed. A
 * refused token stops them all: it concerns every sale.
 */
export async function importSales(ctx: SalesContext, sales: Sale[]): Promise<Record<Imported | "left", number>> {
  const outcome = { imported: 0, failed: 0, skipped: 0, waiting: 0, left: 0 };
  for (let index = 0; index < sales.length; index += 1) {
    if (Date.now() > ctx.deadline) {
      outcome.left = sales.length - index;
      break;
    }
    const sale = sales[index];
    try {
      outcome[await importSale(ctx, sale)] += 1;
    } catch (err) {
      if (err instanceof SquareError && err.kind === "credentials") {
        throw err;
      }
      const attempts = (sale.attempts || 0) + 1;
      const problem = `The store could not import the sale: ${(err as Error).message}`;
      await saveSale(ctx.swell, sale, {
        attempts,
        date_attempted: new Date().toISOString(),
        problem,
        ...(attempts >= MAX_ATTEMPTS ? { status: "failed" } : {}),
      });
      outcome[attempts >= MAX_ATTEMPTS ? "failed" : "waiting"] += 1;
    }
  }
  return outcome;
}
