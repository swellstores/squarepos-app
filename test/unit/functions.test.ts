import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeClaim } from "../../functions/lib/claim";
import resolveSale from "../../functions/resolve-sale";
import { post as squareEvents } from "../../functions/square-events";
import stockChanged from "../../functions/stock-changed";
import sweep from "../../functions/sweep";
import testConnection from "../../functions/test-connection";
import { createRequest } from "../helpers/request";
import { LOCATION, createSquare } from "../helpers/square";
import type { TestSquare } from "../helpers/square";
import { createStore } from "../helpers/store";
import type { TestStore } from "../helpers/store";

type Row = Record<string, any>;

let store: TestStore;
let square: TestSquare;

const SETTINGS = {
  id: "app-record",
  connection: { access_token: "sandbox-token", environment: "sandbox" },
  inventory: { enabled: true },
  sales: { enabled: true },
};
const ADDRESS = "https://alder:pk_test_abc@alder.swell.store/functions/squarepos/square-events";

async function sign(key: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(text)))));
}

/** A notice as Square sends it: the body as text, signed over the registered address */
async function notice(event: Row, key = "key-1") {
  const rawBody = JSON.stringify(event);
  return createRequest(store, { body: event, rawBody, headers: { "x-square-hmacsha256-signature": await sign(key, ADDRESS + rawBody) } });
}

function countNotice(variationId: string, quantity: string): Row {
  return {
    type: "inventory.count.updated",
    data: { object: { inventory_counts: [{ catalog_object_id: variationId, location_id: LOCATION, state: "IN_STOCK", quantity }] } },
  };
}

function addLink(product: Row, variationId: string, agreed: number): Row {
  const link = { id: store.nextId(), key: `${LOCATION}:${variationId}`, location_id: LOCATION, variation_id: variationId, product_id: product.id, variant_id: null, status: "active", agreed };
  store.links.push(link);
  return link;
}

beforeEach(() => {
  store = createStore({ settings: structuredClone(SETTINGS), mode: "function" });
  square = createSquare();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Test connection", () => {
  it("registers Square's notices once, at the app's route with the store's public key, and keeps their signature key", async () => {
    const first = (await testConnection(createRequest(store, { data: { $action: { id: "test-connection" } } }))) as Row;
    await testConnection(createRequest(store, { data: { $action: { id: "test-connection" } } }));

    expect(first.message).toContain("Connected to Alder & Co. (sandbox)");
    expect(square.subscriptions).toHaveLength(1);
    expect(square.subscriptions[0]).toMatchObject({ enabled: true, notification_url: ADDRESS, name: "Swell alder (test)" });
    expect(square.subscriptions[0].event_types).toContain("inventory.count.updated");
    expect(store.state.find((record) => record.key === "webhook")).toMatchObject({ subscription_id: "wbhk_1", signature_key: "key-1", address: ADDRESS });
    expect(store.settings.connection.account).toBe("Alder & Co. (sandbox)");
    // The method imported sales are recorded with, switched off for shoppers
    expect(store.paymentMethods.filter((method) => method.id === "square_pos")).toEqual([{ id: "square_pos", name: "Square POS", manual: true, enabled: false }]);
  });

  it("switches a subscription back on that Square had switched off", async () => {
    await testConnection(createRequest(store));
    square.subscriptions[0].enabled = false;

    await testConnection(createRequest(store));

    expect(square.subscriptions).toHaveLength(1);
    expect(square.subscriptions[0].enabled).toBe(true);
  });

  it("says what to correct when Square refuses the token or does not know a location", async () => {
    store.settings = { ...SETTINGS, connection: { access_token: "wrong" } };
    await expect(testConnection(createRequest(store))).rejects.toMatchObject({ status: 400 });

    store.settings = { ...SETTINGS, sales: { enabled: true, locations: "Harbour" } };
    await expect(testConnection(createRequest(store))).rejects.toThrow(/"Harbour".*"Main Street"/);
    expect(square.subscriptions).toHaveLength(0);
  });

  it("looks up the Swell stock location for the sync, which cannot read the store's settings", async () => {
    store = createStore({
      settings: { ...SETTINGS, inventory: { enabled: true, swell_location: "Shop floor" } },
      shipments: { features: { multi_location: true }, locations: [{ id: "shop", name: "Shop floor" }, { id: "wh", name: "Warehouse" }] },
      mode: "function",
    });

    await testConnection(createRequest(store));

    expect(store.state.find((record) => record.key === "store")).toMatchObject({ swell_location: "Shop floor", swell_location_id: "shop" });
  });
});

describe("a notice from Square", () => {
  let product: Row;

  beforeEach(async () => {
    await testConnection(createRequest(store));
    product = store.addProduct("MUG", 6);
    addLink(product, "V1", 6);
  });

  it("is refused unless Square signed it", async () => {
    const forged = (await squareEvents(await notice(countNotice("V1", "4"), "another-key"))) as Response;

    expect(forged.status).toBe(401);
    expect(store.links[0].marked).toBeUndefined();
    expect(store.runs).toHaveLength(0);
  });

  it("marks the pair and starts one sync, also when notices come in a burst", async () => {
    await squareEvents(await notice(countNotice("V1", "4")));
    await squareEvents(await notice(countNotice("V1", "3")));

    expect(store.links[0].marked).toBe(true);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ name: "sync", data: { source: "square" } });
    // The run was handed the claim that kept the second notice from starting another
    expect(store.state.find((record) => record.key === "run")?.owner).toBe(store.runs[0].data.claim);
  });

  it("starts nothing for the count the sync itself left behind, or for an item that is not linked", async () => {
    await squareEvents(await notice(countNotice("V1", "6")));
    await squareEvents(await notice(countNotice("V9", "2")));

    expect(store.runs).toHaveLength(0);
    expect(store.state.find((record) => record.key === "run")).toBeUndefined();
  });

  it("asks for a sales search when a payment or refund is announced", async () => {
    await squareEvents(await notice({ type: "payment.updated", data: { object: { payment: { id: "P1", status: "COMPLETED" } } } }));

    expect(store.state.find((record) => record.key === "sales")).toMatchObject({ requested: true });
    expect(store.runs).toHaveLength(1);
  });

  it("leaves the notice to the run that is working", async () => {
    await takeClaim(store.swell, "working-run");

    await squareEvents(await notice(countNotice("V1", "4")));

    expect(store.links[0].marked).toBe(true);
    expect(store.runs).toHaveLength(0);
  });
});

describe("a stock change in Swell", () => {
  it("marks the linked item and starts a sync, but not for the change the sync wrote", async () => {
    const product = store.addProduct("MUG", 6);
    addLink(product, "V1", 6);
    const event = (level: number) => createRequest(store, { data: { id: product.id, $event: { data: { stock_level: level, prev_stock_level: 6 } } } });

    expect(await stockChanged(event(6))).toMatchObject({ skipped: expect.any(String) });
    expect(store.runs).toHaveLength(0);

    await stockChanged(event(5));

    expect(store.links[0].marked).toBe(true);
    expect(store.runs).toHaveLength(1);
  });

  it("tells a variant's stock from its product's", async () => {
    const product = store.addProduct("TEE", 0);
    const small = store.addVariant(product, "TEE-S", 5);
    store.links.push({ id: store.nextId(), key: `${LOCATION}:V1`, location_id: LOCATION, variation_id: "V1", product_id: product.id, variant_id: small.id, status: "active", agreed: 5 });

    await stockChanged(createRequest(store, { data: { id: product.id, $event: { data: { stock_level: 9, variant_id: small.id, variant_stock_level: 4 } } } }));

    expect(store.links[0].marked).toBe(true);
  });
});

describe("the sweep", () => {
  it("starts a full comparison every time, unless a run is working or nothing is switched on", async () => {
    await sweep(createRequest(store));
    expect(store.runs[0].data).toMatchObject({ source: "sweep", full: true });

    await sweep(createRequest(store));
    expect(store.runs).toHaveLength(1);

    // The run that is working is asked to compare everything before it ends
    expect(store.state.find((record) => record.key === "sweep")).toMatchObject({ requested: true });

    store = createStore({ settings: { ...SETTINGS, inventory: { enabled: false }, sales: { enabled: false } }, mode: "function" });
    await sweep(createRequest(store));
    expect(store.runs).toHaveLength(0);
  });
});

describe("the hourly check of Square's notices", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises one alert when Square has switched the notices off, and none while they are on", async () => {
    await testConnection(createRequest(store));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:02:00.000Z"));

    await sweep(createRequest(store));
    expect(store.alerts).toHaveLength(0);

    square.subscriptions[0].enabled = false;
    vi.setSystemTime(new Date("2026-10-14T07:01:00.000Z"));
    await sweep(createRequest(store));

    expect(store.alerts.map((alert) => alert.key)).toEqual(["webhook"]);
    expect(store.alerts[0].message).toContain("Test connection");
  });
});

describe("Mark as resolved", () => {
  it("takes a sale off the list that needs attention, and ends the alert with the last one", async () => {
    const sale = { id: store.nextId(), key: "ORDER1", status: "failed", problem: "does not add up" };
    store.sales.push(sale);
    store.alerts.push({ id: store.nextId(), key: "sales", message: "1 sale" });

    await resolveSale(createRequest(store, { data: { $action: { id: "resolve", source: "record", record_id: sale.id } } }));

    expect(store.sales[0]).toMatchObject({ status: "resolved", problem: null });
    expect(store.alerts).toHaveLength(0);
    await expect(resolveSale(createRequest(store, { data: { $action: { record_id: "../orders" } } }))).rejects.toMatchObject({ status: 400 });
  });
});
