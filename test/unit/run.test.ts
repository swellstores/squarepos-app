import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeClaim } from "../../functions/lib/claim";
import { run } from "../../functions/lib/run";
import { cardPayment, cardSale, cashSale } from "../fixtures/square-orders";
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

beforeEach(() => {
  store = createStore({ settings: structuredClone(SETTINGS) });
  square = createSquare({ locations: [{ id: LOCATION, name: "Main Street", status: "ACTIVE" }] });
  square.payments.push(cardPayment);
  store.addPaymentMethod();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("takes over a claim whose run never began, sooner than one of a run that stopped", async () => {
    await takeClaim(store.swell, "queued-run", Date.now(), true);
    state("run")!.date_heartbeat = new Date(Date.now() - 2 * 60 * 1000).toISOString();

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

  it("gives back the claim the starting function took when Square cannot be reached at all", async () => {
    await takeClaim(store.swell, "claim-1", Date.now(), true);
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
  it("imports from about the moment the import is switched on, and from an earlier date on request", async () => {
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
    store.state.push({ id: store.nextId(), key: "sales", cursor: "2026-10-13T00:00:00.000Z", requested: true });
    square.orders.push(cashSale, cardSale);

    await start({ source: "square" });
    await start({ source: "square" }, "function", "run-2");

    expect(store.orders).toHaveLength(2);
    expect(state("sales")).toMatchObject({ cursor: cardSale.updated_at, requested: false });
    // The second run had nothing announced, and did not ask Square
    expect(square.requests("/orders/search")).toHaveLength(1);
  });

  it("raises one alert for sales that need attention, retries them on request, and settles the alert", async () => {
    store.state.push({ id: store.nextId(), key: "sales", cursor: "2026-10-13T00:00:00.000Z", requested: true });
    square.orders.push({ ...cashSale, total_money: { amount: 9999, currency: "USD" } });
    await start({ source: "square" });

    expect(store.sales[0].status).toBe("failed");
    expect(store.alerts.map((alert) => alert.key)).toEqual(["sales"]);

    square.orders[0] = cashSale;
    await start(action("retry-sales", { settings: "sales" }), "action", "run-2");

    expect(store.sales[0].status).toBe("imported");
    expect(store.alerts).toHaveLength(0);
  });
});

describe("when Square says no", () => {
  it("raises the connection alert for a refused token, does nothing else, and clears it when the token works", async () => {
    store.settings = { ...SETTINGS, connection: { access_token: "wrong" } };
    await takeClaim(store.swell, "claim-1");

    const { result } = await start({ source: "sweep", full: true, claim: "claim-1" });

    expect(result.stopped).toBeTruthy();
    expect(store.alerts.map((alert) => alert.key)).toEqual(["connection"]);
    expect(state("run")).toBeUndefined();

    store.settings = structuredClone(SETTINGS);
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
