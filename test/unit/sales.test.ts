import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALK_IN_EMAIL, findSales, importSale, importSales } from "../../functions/lib/sales";
import type { Sale, SalesContext } from "../../functions/lib/sales";
import { cardPayment, cardRefund, cardSale, cashSale, refundOrder, refundedCardPayment } from "../fixtures/square-orders";
import { createSquare } from "../helpers/square";
import type { TestSquare } from "../helpers/square";
import { createStore } from "../helpers/store";
import type { TestStore } from "../helpers/store";

type Row = Record<string, any>;

const LOCATION = cashSale.location_id;
let store: TestStore;
let square: TestSquare;

function context(extra: Partial<SalesContext> = {}): SalesContext {
  return {
    swell: store.swell,
    api: { token: square.token, sandbox: true },
    appId: "squarepos",
    locations: [{ id: LOCATION, name: "Main Street" }],
    announce: false,
    deadline: Date.now() + 60000,
    ...extra,
  };
}

/** Finds the sales Square has and imports the ones that wait, as a run does */
async function run(extra: Partial<SalesContext> = {}) {
  let cursor: string | undefined;
  do {
    cursor = (await findSales(context(extra), "2026-10-01T00:00:00.000Z", cursor)).cursor;
  } while (cursor);
  const waiting = store.sales.filter((sale) => sale.status === "pending").map((sale) => ({ ...sale })) as Sale[];
  return importSales(context(extra), waiting);
}

beforeEach(() => {
  store = createStore();
  square = createSquare({ locations: [{ id: LOCATION, name: "Main Street", status: "ACTIVE" }] });
  square.payments.push(cardPayment);
  store.addPaymentMethod();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importing sales", () => {
  it("creates one paid order per sale, however often the sale is found", async () => {
    square.orders.push(cashSale, cardSale);

    expect(await run()).toMatchObject({ imported: 2, failed: 0 });
    await run();
    await run();

    expect(store.orders).toHaveLength(2);
    const order = store.orders.find((entry) => entry.number === "SQ-eQj3") as Row;
    // Paid by a record of the Square payment, as the dashboard needs it to show the order paid
    expect(order).toMatchObject({ grand_total: 20, payment_total: 20, paid: true, status: "complete" });
    expect(store.payments.filter((payment) => payment.order_id === order.id)).toMatchObject([{ method: "square_pos", amount: 20, transaction_id: cardSale.tenders[0].id }]);
    expect(store.sales.find((sale) => sale.key === cardSale.id)).toMatchObject({
      status: "imported",
      order_id: order.id,
      order_number: "SQ-eQj3",
      name: "Receipt eQj3",
      location_name: "Main Street",
      tender: "Card (Visa 5858)",
      total: 20,
      currency: "USD",
    });
    // A workflow's writes record no events unless they ask to
    expect(store.events).toEqual([]);
  });

  it("puts a sale without a known customer on one walk-in account", async () => {
    square.orders.push(cashSale, cardSale);

    await run();

    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]).toMatchObject({ email: WALK_IN_EMAIL, email_optin: false });
    expect(store.orders.every((order) => order.account_id === store.accounts[0].id)).toBe(true);
  });

  it("puts a sale on the Swell account that has the Square customer's e-mail address, and creates none", async () => {
    store.accounts.push({ id: store.nextId(), email: "pat@example.com", name: "Pat Walker" });
    square.customers.push({ id: "C1", given_name: "Pat", family_name: "Walker", email_address: "Pat@Example.com" }, { id: "C2", given_name: "Sam", email_address: "sam@example.com" });
    square.orders.push({ ...cashSale, customer_id: "C1" }, { ...cardSale, customer_id: "C2" });

    await run();

    expect(store.orders.find((order) => order.number.startsWith("SQ-n0Eg"))?.account_id).toBe(store.accounts[0].id);
    expect(store.accounts.map((account) => account.email)).toEqual(["pat@example.com", WALK_IN_EMAIL]);
    expect(store.sales.find((sale) => sale.key === cardSale.id)).toMatchObject({ customer_name: "Sam", customer_email: "sam@example.com" });
  });

  it("goes on with the other sales when the store refuses one, and lists it after some attempts", async () => {
    square.orders.push(cashSale, cardSale);
    const refusing = { when: (method: string, path: string, data: Record<string, any>) => method === "post" && path === "/orders" && data.number?.startsWith("SQ-n0Eg"), error: new Error("Workflow runtime API request was not authorized") };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.failures.push(refusing);
    }

    expect(await run()).toMatchObject({ imported: 1, waiting: 1 });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await run();
    }

    expect(store.sales.find((sale) => sale.key === cashSale.id)).toMatchObject({ status: "failed", attempts: 5 });
    expect(store.orders).toHaveLength(1);
  });

  it("adopts the order of an attempt that stopped before the sale's record was saved", async () => {
    square.orders.push(cardSale);
    store.failures.push({ when: (method, path, data) => method === "put" && path.startsWith("/sales/") && data.status === "imported", error: new Error("store unavailable") });

    expect(await run()).toMatchObject({ waiting: 1 });
    expect(store.orders).toHaveLength(1);
    await run();

    expect(store.orders).toHaveLength(1);
    expect(store.sales[0]).toMatchObject({ status: "imported", order_id: store.orders[0].id });
  });

  it("lists a sale that Swell refuses with the reason, and goes on with the others", async () => {
    square.orders.push({ ...cashSale, total_money: { amount: 9999, currency: "USD" } }, cardSale);

    expect(await run()).toMatchObject({ imported: 1, failed: 1 });

    expect(store.orders).toHaveLength(1);
    const failed = store.sales.find((sale) => sale.key === cashSale.id) as Row;
    expect(failed.status).toBe("failed");
    expect(failed.problem).toContain("99.99 USD");
  });

  it("leaves out a sale taken by an online checkout through Square's API, except in the sandbox", async () => {
    square.orders.push(cardSale);

    await run({ api: { token: square.token, sandbox: false } });

    expect(store.orders).toHaveLength(0);
    expect(store.sales[0].status).toBe("skipped");
  });

  it("does not import an exchange", async () => {
    square.orders.push({ ...cardSale, returns: refundOrder.returns });

    await run();

    expect(store.orders).toHaveLength(0);
    expect(store.sales[0].status).toBe("skipped");
  });

  it("waits while Square cannot be reached, then lists the sale", async () => {
    square.orders.push(cardSale);
    await findSales(context(), "2026-10-01T00:00:00.000Z");
    square.intercept((call) => (call.path.startsWith("/orders/") ? square.unavailable() : undefined));
    const sale = () => ({ ...store.sales[0] }) as Sale;

    expect(await importSale(context(), sale())).toBe("waiting");
    expect(store.sales[0]).toMatchObject({ status: "pending", attempts: 1 });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await importSale(context(), sale());
    }

    expect(store.sales[0].status).toBe("failed");
    expect(store.orders).toHaveLength(0);
  });

  it("lists the sale when the store has no Square POS payment method, and records it once it has", async () => {
    store.paymentMethods.splice(store.paymentMethods.findIndex((method) => method.id === "square_pos"), 1);
    square.orders.push(cardSale);

    await run();
    expect(store.sales[0].status).toBe("failed");
    expect(store.sales[0].problem).toContain("Test connection");

    store.addPaymentMethod();
    store.sales[0].status = "pending";
    await run();

    expect(store.orders).toHaveLength(1);
    expect(store.orders[0]).toMatchObject({ paid: true });
    expect(store.sales[0].status).toBe("imported");
  });

  it("announces the order to other apps only when the merchant asked for it", async () => {
    square.orders.push(cardSale);

    await run({ announce: true });

    expect(store.events).toEqual(["created /orders", "created /payments"]);
  });
});

describe("refunds", () => {
  it("records a partial refund on the sale and its order, and a full one as refunded", async () => {
    square.orders.push(cardSale);
    await run();
    square.orders.push(refundOrder);

    await run();
    await run();

    const order = store.orders[0];
    expect(store.sales[0]).toMatchObject({ refunded: 5, refund_state: "partial" });
    expect(order).toMatchObject({ refund_total: 5, refunded: false });
    expect(order.$app.squarepos.refunded).toBe(5);

    square.orders.push({
      ...refundOrder,
      id: "second-refund",
      returns: refundOrder.returns,
      updated_at: "2026-10-13T19:00:00.000Z",
      refunds: [{ ...refundOrder.refunds[0], id: "R2", amount_money: { amount: 1500, currency: "USD" } }],
    });
    await run();

    expect(store.sales[0]).toMatchObject({ refunded: 20, refund_state: "full" });
    expect(store.sales[0].refunds).toHaveLength(2);
    expect(order).toMatchObject({ refund_total: 20, refunded: true });
  });

  it("is on the order from the start when it was made before the sale was imported, and is not counted again", async () => {
    // Square changes the refund order before the sale: a search by time of change finds the refund first
    square.payments.splice(0, 1, refundedCardPayment);
    square.refunds.push(cardRefund);
    square.orders.push(cardSale, refundOrder);

    await run();
    await run();

    expect(store.sales[0]).toMatchObject({ status: "imported", refunded: 5, refund_state: "partial" });
    expect(store.sales[0].refunds).toHaveLength(1);
    expect(store.orders[0]).toMatchObject({ refund_total: 5, payment_total: 20 });
    expect(store.orders[0].$app.squarepos.refunded).toBe(5);
  });

  it("lists the sale when the store refuses a refund, and records it once on retry", async () => {
    square.orders.push(cardSale);
    await run();
    square.orders.push(refundOrder);
    store.failures.push({ when: (method, path) => method === "post" && path.endsWith("/refunds"), error: new Error("store unavailable") });

    // Cut short while recording: the sale does not claim the refund yet, the next search finds it new
    await expect(run()).rejects.toThrow("store unavailable");
    expect(store.sales[0].refunds || []).toHaveLength(0);
    await run();

    expect(store.orders[0].refund_total).toBe(5);
    expect(store.sales[0]).toMatchObject({ status: "imported", refunded: 5 });
  });

  it("ignores a refund of a sale from before the import", async () => {
    square.orders.push(refundOrder);

    await run();

    expect(store.sales).toHaveLength(0);
    expect(store.orders).toHaveLength(0);
  });
});
