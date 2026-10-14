import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeClaim } from "../../functions/lib/claim";
import { run } from "../../functions/lib/run";
import { cardPayment, cardSale, cashSale, refundOrder } from "../fixtures/square-orders";
import type { Steps } from "../../functions/lib/run";
import { createSteps, runRequest } from "../helpers/request";
import { createSquare } from "../helpers/square";
import type { TestSquare } from "../helpers/square";
import { createStore } from "../helpers/store";
import type { TestStore } from "../helpers/store";

type Row = Record<string, any>;

const LOCATION = cashSale.location_id;
let store: TestStore;
let square: TestSquare;

const SETTINGS = {
  id: "app-record",
  connection: { access_token: "sandbox-token", environment: "sandbox" },
  inventory: { enabled: true },
  sales: { enabled: true },
};

function action(id: string, extra: Row = {}, values: Row = {}): Row {
  return { ...values, $action: { id, source: "settings", user_id: "u1", ...extra } };
}

async function start(data: Row = {}, trigger: "function" | "action" = "function", instance = "run-1") {
  const { steps, names } = createSteps();
  const result = await run(runRequest(store, data, trigger, instance), steps);
  return { result, names };
}

const state = (key: string) => store.state.find((record) => record.key === key);
const link = (sku: string) => store.links.find((record) => record.sku === sku) as Row;

/** The platform computes the hidden date fields as part of each settings write. */
async function saveSettings(values: Row, at: string) {
  const previous = structuredClone(store.settings);
  const data = { ...previous, ...values, sales: { ...previous.sales, ...values.sales }, date_updated: at };
  data.sales.enabled_at = data.sales.enabled ? data.sales.enabled_at || at : null;
  store.settings = data;
}

beforeEach(() => {
  store = createStore({ settings: structuredClone(SETTINGS) });
  store.settings.sales.enabled_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  square = createSquare({ locations: [{ id: LOCATION, name: "Main Street", status: "ACTIVE" }] });
  square.payments.push(cardPayment);
  store.addPaymentMethod();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("from matching to a shared stock", () => {
  let mug: Row;

  beforeEach(async () => {
    mug = store.addProduct("MUG", 4);
    store.addProduct("CAP", 2);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    square.addItem("Cap", [{ id: "V2", sku: "CAP", count: 3 }]);
    square.addItem("Pin", [{ id: "V3", sku: "PIN", count: 1 }]);
    await start(action("match"), "action");
  });

  it("matches the whole catalog page by page, without touching stock", () => {
    expect(store.links.map((record) => [record.sku, record.status])).toEqual([
      ["MUG", "ready"],
      ["CAP", "ready"],
      ["PIN", "unlinked"],
    ]);
    expect(store.level(mug)).toBe(4);
    expect(state("run")).toBeUndefined();
  });

  it("starts the chosen pairs with the side the merchant named, then keeps them in sync", async () => {
    const selection = { all: false, ids: [link("MUG").id], count: 1, query: { $and: [{ id: { $in: [link("MUG").id] } }] } };
    await start(action("start-selected", { source: "bulk", selection }, { side: "square" }), "action");

    expect(link("MUG")).toMatchObject({ status: "active", agreed: 6, marked: false });
    expect(store.level(mug)).toBe(6);
    expect(link("CAP").status).toBe("ready");

    // A sale at the till, announced by nobody: the sweep finds it
    square.sell("V1", 2);
    await start({ source: "sweep", full: true }, "function", "run-2");

    expect(store.level(mug)).toBe(4);
    expect(state("run")).toBeUndefined();
  });

  it("stops a pair without changing either side", async () => {
    await start(action("start", { source: "record", record_id: link("MUG").id }, { side: "swell" }), "action");
    expect(square.count("V1")).toBe(4);

    await start(action("stop", { source: "record", record_id: link("MUG").id }), "action", "run-2");
    square.sell("V1", 1);
    await start({ source: "sweep", full: true }, "function", "run-3");

    expect(link("MUG")).toMatchObject({ status: "ready", agreed: null });
    expect(store.level(mug)).toBe(4);
    expect(square.count("V1")).toBe(3);
  });

  it("raises one alert for items that stopped, and ends it once they are started again", async () => {
    await start(action("start", { source: "record", record_id: link("MUG").id }, { side: "square" }), "action");
    // Its product deleted
    link("MUG").product_id = "f".repeat(24);
    await start({ source: "sweep", full: true }, "function", "run-2");

    expect(link("MUG").status).toBe("error");
    expect(store.alerts.map((alert) => alert.key)).toEqual(["stock"]);

    link("MUG").product_id = mug.id;
    await start(action("start", { source: "record", record_id: link("MUG").id }, { side: "square" }), "action", "run-3");

    expect(link("MUG").status).toBe("active");
    expect(store.alerts).toHaveLength(0);
  });

  it("leaves the stock alone while the sync is switched off", async () => {
    store.settings = { ...SETTINGS, inventory: { enabled: false } };
    await start(action("start", { source: "record", record_id: link("MUG").id }, { side: "square" }), "action");

    expect(link("MUG")).toMatchObject({ status: "active", marked: true });
    expect(store.level(mug)).toBe(4);
  });
});

describe("one run at a time", () => {
  beforeEach(() => {
    const mug = store.addProduct("MUG", 6);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    store.links.push({ id: store.nextId(), key: `${LOCATION}:V1`, sku: "MUG", location_id: LOCATION, variation_id: "V1", product_id: mug.id, variant_id: null, status: "active", agreed: 6, marked: true });
    square.sell("V1", 1);
  });

  it("works with the claim the starting function took, and gives it back", async () => {
    await takeClaim(store.swell, "claim-1");

    await start({ source: "square", claim: "claim-1" });

    expect(store.level(store.products[0])).toBe(5);
    expect(state("run")).toBeUndefined();
  });

  it("ends at once when another run is working, and leaves the mark for it", async () => {
    await takeClaim(store.swell, "other-run");

    const { result } = await start({ source: "square" });

    expect(result.stopped).toBe("Another sync is running.");
    expect(store.level(store.products[0])).toBe(6);
    expect(link("MUG").marked).toBe(true);
    expect(state("run")?.owner).toBe("other-run");
  });

  it("takes over the claim of a run that died", async () => {
    await takeClaim(store.swell, "dead-run");
    state("run")!.date_heartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await start({ source: "sweep", full: true });

    expect(store.level(store.products[0])).toBe(5);
  });

  it("looks again for marks that came while it worked", async () => {
    let late = true;
    square.intercept((call) => {
      if (late && call.path === "/inventory/changes/batch-create") {
        // While the first change is sent, the till sells again and Square's notice marks the pair
        late = false;
        queueMicrotask(() => {
          square.sell("V1", 1);
          link("MUG").marked = true;
        });
      }
      return undefined;
    });
    store.adjust(store.products[0], -1, "sold");

    const { names } = await start({ source: "square" });

    expect(store.level(store.products[0])).toBe(3);
    expect(square.count("V1")).toBe(3);
    expect(names).toContain("stock 2.1");
    expect(state("run")).toBeUndefined();
  });

  it("leaves the stock alone once the sync is switched off after the run began", async () => {
    const { steps } = createSteps();
    const switching: Steps = {
      ...steps,
      async do(name, options, work) {
        const result = await steps.do(name, options, work);
        if (name === "prepare") {
          store.settings.inventory.enabled = false;
        }
        return result;
      },
    };

    const result = await run(runRequest(store, { source: "square" }), switching);

    expect(result.stock).toContain("settings changed");
    expect(store.level(store.products[0])).toBe(6);
    expect(square.count("V1")).toBe(5);
    expect(link("MUG").marked).toBe(true);
    expect(state("run")).toBeUndefined();
  });

  it("gives back the claim the starting function took when Square cannot be reached at all", async () => {
    await takeClaim(store.swell, "claim-1");
    square.intercept((call) => (call.path === "/merchants/me" ? square.unavailable() : undefined));

    await expect(start({ source: "square", claim: "claim-1" })).rejects.toThrow();

    expect(state("run")).toBeUndefined();
  });

  it("gives the claim back when a step fails for good", async () => {
    square.intercept((call) => (call.path === "/inventory/counts/batch-retrieve" ? square.unavailable() : undefined));

    await expect(start({ source: "square" })).rejects.toThrow();

    expect(state("run")).toBeUndefined();
    expect(link("MUG").marked).toBe(true);
  });
});

describe("sales in a run", () => {
  it("imports from the saved enable boundary, and from an earlier date on request", async () => {
    square.orders.push(cashSale, cardSale);
    const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    square.orders.push({ ...cashSale, id: "recent-sale", closed_at: minuteAgo, updated_at: minuteAgo });
    // A sale of yesterday that Square changed a minute ago (refunded, for example)
    square.orders.push({ ...cashSale, id: "changed-sale", updated_at: minuteAgo });

    await start({ source: "sweep", full: true });
    // The sale of a minute ago is in, the ones of yesterday are not
    expect(store.orders.map((order) => order.$app.squarepos.square_order_id)).toEqual(["recent-sale"]);
    expect(store.sales.map((sale) => sale.key)).toEqual(["recent-sale"]);
    expect(state("sales")?.cursor).toBeTruthy();

    await start(action("import-past", { settings: "sales" }, { since: "2026-10-13T18:19:00.000Z" }), "action", "run-2");

    expect(store.orders.map((order) => order.number)).toContain("SQ-eQj3");
    // The changed sale was completed before the date asked for
    expect(store.orders).toHaveLength(2);
  });

  it("searches when Square announced a payment, and moves on to where it got", async () => {
    store.settings.sales.enabled_at = "2026-10-13T00:00:00.000Z";
    store.state.push({ id: store.nextId(), key: "sales", enabled_at: "2026-10-13T00:00:00.000Z", cursor: "2026-10-13T00:00:00.000Z", requested: true });
    square.orders.push(cashSale, cardSale);

    await start({ source: "square" });
    await start({ source: "square" }, "function", "run-2");

    expect(store.orders).toHaveLength(2);
    // Read to its end: the next search starts where this one ended
    expect(state("sales")).toMatchObject({ requested: false, search: null });
    expect(state("sales")!.cursor > cardSale.updated_at).toBe(true);
    // The second run had nothing announced, and did not ask Square
    expect(square.requests("/orders/search")).toHaveLength(1);
  });

  it("raises one alert for sales that need attention, retries them on request, and settles the alert", async () => {
    store.settings.sales.enabled_at = "2026-10-13T00:00:00.000Z";
    store.state.push({ id: store.nextId(), key: "sales", enabled_at: "2026-10-13T00:00:00.000Z", cursor: "2026-10-13T00:00:00.000Z", requested: true });
    square.orders.push({ ...cashSale, total_money: { amount: 9999, currency: "USD" } });
    await start({ source: "square" });

    expect(store.sales[0].status).toBe("failed");
    expect(store.alerts.map((alert) => alert.key)).toEqual(["sales"]);

    square.orders[0] = cashSale;
    await start(action("retry-sales", { settings: "sales" }), "action", "run-2");

    expect(store.sales[0].status).toBe("imported");
    expect(store.alerts).toHaveLength(0);
  });

  it("raises the alert when the store refuses a refund the search found", async () => {
    store.settings.sales.enabled_at = "2026-10-13T00:00:00.000Z";
    store.state.push({ id: store.nextId(), key: "sales", enabled_at: "2026-10-13T00:00:00.000Z", cursor: "2026-10-13T00:00:00.000Z", requested: true });
    square.orders.push(cardSale);
    await start({ source: "square" });
    expect(store.sales[0].status).toBe("imported");

    // More than the payment of 20.00: the store refuses it
    const now = new Date().toISOString();
    square.orders.push({
      ...refundOrder,
      id: "too-much",
      updated_at: now,
      refunds: [{ ...refundOrder.refunds[0], id: "R9", amount_money: { amount: 3000, currency: "USD" } }],
    });
    await start({ source: "sweep", full: true }, "function", "run-2");

    expect(store.sales[0].status).toBe("failed");
    expect(store.alerts.map((alert) => alert.key)).toEqual(["sales"]);
  });

  it("imports a long list of sales a few at a time, and syncs the stock in between", async () => {
    const mug = store.addProduct("MUG", 6);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    store.links.push({ id: store.nextId(), key: `${LOCATION}:V1`, sku: "MUG", location_id: LOCATION, variation_id: "V1", product_id: mug.id, variant_id: null, status: "active", agreed: 6, marked: false });
    const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    for (let index = 0; index < 45; index += 1) {
      square.orders.push({ ...cashSale, id: `sale-${index}`, closed_at: minuteAgo, updated_at: minuteAgo });
    }
    // The till sells while the first sales are imported
    let sold = false;
    square.intercept((call) => {
      if (!sold && call.path.startsWith("/orders/sale-")) {
        sold = true;
        square.sell("V1", 1);
        link("MUG").marked = true;
      }
      return undefined;
    });

    const { names } = await start({ source: "sweep", full: true });

    expect(names).not.toContain("import 1.4");
    expect(names.indexOf("stock 2.1")).toBeLessThan(names.indexOf("import 2.1"));
    expect(store.level(mug)).toBe(5);
    expect(store.sales.filter((sale) => sale.status === "imported")).toHaveLength(45);
  });
});

describe("where the sales search starts and how far it gets", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

  it("starts when the import was switched on, and anew after it was switched off", async () => {
    store.settings = { ...SETTINGS, sales: { enabled: false } };
    await saveSettings({ sales: { enabled: true } }, minutesAgo(30));
    square.orders.push(
      { ...cashSale, id: "before-on", closed_at: minutesAgo(31), updated_at: minutesAgo(31) },
      // Completed while Square could not be reached: the first search came twenty minutes later
      { ...cashSale, id: "after-on", closed_at: minutesAgo(25), updated_at: minutesAgo(25) },
    );
    await start({ source: "sweep", full: true });
    expect(store.sales.map((sale) => sale.key)).toEqual(["after-on"]);

    await saveSettings({ sales: { enabled: false } }, minutesAgo(15));
    await start({ source: "sweep", full: true }, "function", "run-2");
    square.orders.push({ ...cashSale, id: "while-off", closed_at: minutesAgo(10), updated_at: minutesAgo(10) });

    await saveSettings({ sales: { enabled: true } }, minutesAgo(5));
    square.orders.push({ ...cashSale, id: "on-again", closed_at: minutesAgo(4), updated_at: minutesAgo(4) });
    await start({ source: "sweep", full: true }, "function", "run-3");
    expect(store.sales.map((sale) => sale.key)).toEqual(["after-on", "on-again"]);
  });

  it("excludes sales during an off/on cycle that no sweep or notice observed", async () => {
    await start({ full: true });
    const at = minutesAgo(2);
    await saveSettings({ sales: { enabled: false } }, minutesAgo(4));
    square.orders.push({ ...cashSale, id: "while-off", closed_at: minutesAgo(3), updated_at: minutesAgo(3) });
    await saveSettings({ sales: { enabled: true } }, at);
    square.orders.push({ ...cashSale, id: "after-reenable", closed_at: minutesAgo(1), updated_at: minutesAgo(1) });

    await start({ full: true }, "function", "run-2");

    expect(store.sales.map((sale) => sale.key)).toEqual(["after-reenable"]);
    expect(state("sales")?.date_from).toBe(at);
  });

  it("keeps the enable boundary through later saves and a failed first connection", async () => {
    store.settings = { ...SETTINGS, sales: { enabled: false }, connection: { ...SETTINGS.connection, access_token: "wrong" } };
    const at = minutesAgo(30);
    await saveSettings({ sales: { enabled: true } }, at);
    square.orders.push({ ...cashSale, id: "during-outage", closed_at: minutesAgo(25), updated_at: minutesAgo(25) });
    await start({ full: true });
    await saveSettings({ connection: SETTINGS.connection }, minutesAgo(5));

    await start({ full: true }, "function", "run-2");

    expect(store.sales.map((sale) => sale.key)).toEqual(["during-outage"]);
    expect(state("sales")?.date_from).toBe(at);
  });

  it("names a missing start time instead of guessing one from the latest save", async () => {
    store.settings = { ...SETTINGS, date_updated: minutesAgo(5) };

    await start({ full: true });

    expect(square.requests("/orders/search")).toHaveLength(0);
    expect(store.alerts).toEqual([expect.objectContaining({ key: "connection", message: expect.stringContaining("no start time") })]);
  });

  it("searches every location, ten at a time", async () => {
    const locations = Array.from({ length: 12 }, (_, index) => ({ id: `L${index}`, name: `Shop ${index}`, status: "ACTIVE" }));
    square = createSquare({ locations });
    square.payments.push(cardPayment);
    square.orders.push({ ...cashSale, id: "at-twelfth", location_id: "L11", closed_at: minutesAgo(1), updated_at: minutesAgo(1) });

    await start({ source: "sweep", full: true });

    expect(store.sales.map((sale) => [sale.key, sale.status])).toEqual([["at-twelfth", "imported"]]);
  });

  it("goes on with a search where it stopped, in the next run, without skipping orders of one time", async () => {
    // More past sales changed at the same moment than one run reads, a page of two per step
    const moment = "2026-10-13T12:00:00.000Z";
    for (let index = 0; index < 70; index += 1) {
      square.orders.push({ ...cashSale, id: `past-${index}`, closed_at: moment, updated_at: moment });
    }
    const real = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    square.intercept((call) => {
      if (call.path === "/orders/search") {
        // Each page takes the step's whole time
        offset += 41 * 1000;
      }
      return undefined;
    });

    await start(action("import-past", { settings: "sales" }, { since: "2026-10-13T00:00:00.000Z" }), "action");
    expect(state("sales")?.past).toMatchObject({ group: 0, page: expect.any(String) });
    for (let run = 2; !store.sales.every((sale) => sale.status === "imported") || state("sales")?.past; run += 1) {
      expect(run).toBeLessThan(10);
      await start({ source: "sweep", full: true }, "function", `run-${run}`);
    }

    expect(store.sales).toHaveLength(70);
  });
});

describe("when Square says no", () => {
  it("raises the connection alert for a refused token, does nothing else, and clears it when the token works", async () => {
    store.settings.connection = { ...SETTINGS.connection, access_token: "wrong" };
    await takeClaim(store.swell, "claim-1");

    const { result } = await start({ source: "sweep", full: true, claim: "claim-1" });

    expect(result.stopped).toBeTruthy();
    expect(store.alerts.map((alert) => alert.key)).toEqual(["connection"]);
    expect(state("run")).toBeUndefined();

    store.settings.connection = structuredClone(SETTINGS.connection);
    await start({ source: "sweep", full: true }, "function", "run-2");

    expect(store.alerts).toHaveLength(0);
  });

  it("names a location the settings ask for and Square does not have", async () => {
    store.settings = { ...SETTINGS, inventory: { enabled: true, location: "Harbour" } };

    await start({ source: "sweep", full: true });

    expect(store.alerts[0].message).toContain('"Harbour"');
    expect(store.alerts[0].message).toContain('"Main Street"');
  });
});
