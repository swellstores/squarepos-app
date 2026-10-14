import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncLinks } from "../../functions/lib/stock";
import type { Link, StockContext } from "../../functions/lib/stock";
import { LOCATION, createSquare } from "../helpers/square";
import type { TestSquare } from "../helpers/square";
import { createStore } from "../helpers/store";
import type { TestStore } from "../helpers/store";

type Row = Record<string, any>;

let store: TestStore;
let square: TestSquare;

function context(extra: Partial<StockContext> = {}): StockContext {
  return { swell: store.swell, api: { token: square.token, sandbox: true }, locationId: LOCATION, deadline: Date.now() + 60000, ...extra };
}

/** A pair of a Swell product (or variant) and a Square variation, as the app records it */
function pair(record: Row, variationId: string, values: Row = {}): Link {
  const link = {
    id: store.nextId(),
    key: `${LOCATION}:${variationId}`,
    location_id: LOCATION,
    variation_id: variationId,
    product_id: record.parent_id || record.id,
    variant_id: record.parent_id ? record.id : null,
    status: "active",
    seq: 0,
    ...values,
  };
  store.links.push(link);
  return link as Link;
}

async function sync(extra: Partial<StockContext> = {}) {
  return syncLinks(
    context(extra),
    store.links.filter((link) => link.status === "active").map((link) => ({ ...link })) as Link[],
  );
}

/** Time moves on between a sync and what happens after it, as it does in a shop */
const later = () => new Promise((resolve) => setTimeout(resolve, 3));

beforeEach(() => {
  store = createStore();
  square = createSquare();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("starting a pair", () => {
  it("gives Swell the quantity of Square when Square is right", async () => {
    const product = store.addProduct("TEE", 3);
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 12 }]);
    pair(product, "V1", { start: "square", marked: true });

    const outcome = await sync();

    expect(outcome.changed).toBe(1);
    expect(store.level(product)).toBe(12);
    expect(square.count("V1")).toBe(12);
    expect(store.links[0]).toMatchObject({ agreed: 12, start: null, marked: false, pending: false, step: null });
    expect(store.stock.at(-1)).toMatchObject({ quantity: 9, reason: "received", reason_message: "Square POS: starting stock taken from Square" });
  });

  it("gives Square the quantity of Swell when Swell is right, also for an item Square never counted", async () => {
    const counted = store.addProduct("TEE", 3);
    const fresh = store.addProduct("CAP", 7);
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 12 }]);
    square.addItem("Cap", [{ id: "V2", sku: "CAP" }]);
    pair(counted, "V1", { start: "swell" });
    pair(fresh, "V2", { start: "swell" });

    await sync();

    expect(square.count("V1")).toBe(3);
    expect(square.count("V2")).toBe(7);
    expect(store.level(counted)).toBe(3);
    // Neither sold nor lost: stock removed, stock received
    expect(square.adjustments.map((adjustment) => [adjustment.from_state, adjustment.to_state, adjustment.quantity])).toEqual([
      ["IN_STOCK", "NONE", "9"],
      ["NONE", "IN_STOCK", "7"],
    ]);
  });

  it("keeps an item Square never counted in sync when it is started from Swell at zero", async () => {
    const product = store.addProduct("CAP", 0);
    square.addItem("Cap", [{ id: "V2", sku: "CAP" }]);
    pair(product, "V2", { start: "swell" });

    await sync();
    await sync();
    expect(store.links[0]).toMatchObject({ status: "active", agreed: 0 });

    store.adjust(product, 4, "received");
    await later();
    await sync();

    expect(store.links[0]).toMatchObject({ status: "active", agreed: 4 });
    expect(square.count("V2")).toBe(4);
    expect(store.level(product)).toBe(4);
  });

  it("does not take a missing count for zero", async () => {
    const product = store.addProduct("CAP", 7);
    square.addItem("Cap", [{ id: "V2", sku: "CAP" }]);
    pair(product, "V2", { start: "square" });

    const outcome = await sync();

    expect(outcome.stopped).toBe(1);
    expect(store.level(product)).toBe(7);
    expect(store.links[0].status).toBe("error");
    expect(store.links[0].reason).toContain("no stock count");
  });
});

describe("a pair in sync", () => {
  let product: Row;

  beforeEach(() => {
    product = store.addProduct("TEE", 10);
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 10 }]);
    pair(product, "V1", { agreed: 10, date_read: new Date().toISOString() });
  });

  it("counts a sale on each side at the same moment", async () => {
    await later();
    store.adjust(product, -1, "sold");
    square.sell("V1", 2);

    await sync();

    expect(store.level(product)).toBe(7);
    expect(square.count("V1")).toBe(7);
    expect(store.links[0]).toMatchObject({ agreed: 7, last_change: "−2 from Square, −1 from Swell", oversold: false });
    // Each side is told what the other did, in its own words
    expect(store.stock.at(-1)).toMatchObject({ quantity: -2, reason: "sold", reason_message: "Square POS: 2 sold" });
    expect(square.adjustments.at(-1)).toMatchObject({ from_state: "IN_STOCK", to_state: "SOLD", quantity: "1", from_location_id: LOCATION, to_location_id: LOCATION });
  });

  it("writes nothing when nothing changed, and does not answer its own changes", async () => {
    await later();
    square.sell("V1", 1);
    await sync();
    const writes = store.swell.put.mock.calls.length + store.swell.post.mock.calls.length;
    const sent = square.requests("/inventory/changes/batch-create").length;

    await sync();
    await sync();

    expect(store.swell.put.mock.calls.length + store.swell.post.mock.calls.length).toBe(writes);
    expect(square.requests("/inventory/changes/batch-create").length).toBe(sent);
    expect(store.level(product)).toBe(9);
    expect(square.count("V1")).toBe(9);
  });

  it("shows the last unit sold on both sides as oversold", async () => {
    store.links[0].agreed = 1;
    store.adjust(product, -9, "missing");
    square.setCount("V1", 1);
    await sync();
    await later();

    store.adjust(product, -1, "sold");
    square.sell("V1", 1);
    await sync();

    expect(store.level(product)).toBe(-1);
    expect(square.count("V1")).toBe(-1);
    expect(store.links[0].oversold).toBe(true);
  });

  it("passes a change on without a reason when Square's history does not explain it", async () => {
    // A sale taken offline is dated when it was made, and is not among the recent changes
    square.setCount("V1", 6);

    await sync();

    expect(store.level(product)).toBe(6);
    expect(store.stock.at(-1)).toMatchObject({ quantity: -4, reason: "missing", reason_message: "Square POS: stock changed in Square" });
  });

  it("takes the mark off before reading, so a notice that comes during the sync stays", async () => {
    store.links[0].marked = true;
    square.sell("V1", 1);
    square.intercept((call) => {
      if (call.path === "/inventory/counts/batch-retrieve") {
        // A notice arrives while the quantities are being read
        expect(store.links[0].marked).toBe(false);
        store.links[0].marked = true;
      }
      return undefined;
    });

    await sync();

    expect(store.level(product)).toBe(9);
    expect(store.links[0].marked).toBe(true);
  });

  it("stops the pair, not the sync, when the Swell product is gone", async () => {
    const other = store.addProduct("CAP", 4);
    square.addItem("Cap", [{ id: "V2", sku: "CAP", count: 6 }]);
    pair(other, "V2", { agreed: 4 });
    store.products.splice(store.products.indexOf(product), 1);

    const outcome = await sync();

    expect(outcome).toMatchObject({ stopped: 1, changed: 1 });
    expect(store.links[0]).toMatchObject({ status: "error", reason: "The Swell product or variant no longer exists." });
    expect(store.level(other)).toBe(6);
  });

  it("stops only the pair that Square refuses", async () => {
    const other = store.addProduct("CAP", 4);
    square.addItem("Cap", [{ id: "V2", sku: "CAP", count: 4 }]);
    pair(other, "V2", { agreed: 4 });
    store.adjust(product, -1, "sold");
    store.adjust(other, -1, "sold");
    // Deleted in Square after its count was read
    square.items[1].item_data.variations[0].is_deleted = true;

    const outcome = await sync();

    expect(outcome).toMatchObject({ stopped: 1, changed: 1 });
    expect(square.count("V1")).toBe(9);
    expect(store.links[1].status).toBe("error");
    expect(store.links[1].reason).toContain("Square refused the stock change");
    expect(store.links[1].step).toBeNull();
  });
});

describe("a sync that is cut short", () => {
  let product: Row;

  beforeEach(() => {
    product = store.addProduct("TEE", 10);
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 10 }]);
    pair(product, "V1", { agreed: 10 });
    store.adjust(product, -1, "sold");
    square.sell("V1", 2);
  });

  it("finishes the written step after Square got its part and Swell did not", async () => {
    store.failures.push({ when: (method, path) => method === "post" && path === "/products:stock", error: new Error("store unavailable") });

    await expect(sync()).rejects.toThrow("store unavailable");
    expect(square.count("V1")).toBe(7);
    expect(store.level(product)).toBe(9);
    expect(store.links[0]).toMatchObject({ pending: true, agreed: 10 });
    // More happens before the next run
    square.sell("V1", 1);

    await sync();

    // The step as written: Square is not sent the sale a second time, Swell gets its two
    expect(store.level(product)).toBe(6);
    expect(square.count("V1")).toBe(6);
    expect(store.links[0]).toMatchObject({ pending: false, step: null, agreed: 6 });
  });

  it("sends the written step once after Square could not be reached", async () => {
    square.intercept((call) => (call.path === "/inventory/changes/batch-create" ? square.unavailable() : undefined));

    await expect(sync()).rejects.toThrow();
    expect(store.links[0].pending).toBe(true);
    square.intercept(undefined);

    await sync();
    await sync();

    expect(store.level(product)).toBe(7);
    expect(square.count("V1")).toBe(7);
  });

  it("writes the Swell stock entry once when the step is repeated after it", async () => {
    store.failures.push({ when: (method, path, data) => method === "put" && path.startsWith("/items/") && data.step === null, error: new Error("store unavailable") });

    await expect(sync()).rejects.toThrow("store unavailable");
    const entries = store.stock.length;
    await sync();

    expect(store.stock.length).toBe(entries);
    expect(store.level(product)).toBe(7);
    expect(square.count("V1")).toBe(7);
  });

  it("puts the marks back when the quantities could not be read", async () => {
    store.links[0].marked = true;
    square.intercept((call) => (call.path === "/inventory/counts/batch-retrieve" ? square.unavailable() : undefined));

    await expect(sync()).rejects.toThrow();

    expect(store.links[0].marked).toBe(true);
    expect(store.links[0].step).toBeUndefined();
  });
});

describe("where the stock is kept", () => {
  it("shares a variant's stock", async () => {
    const product = store.addProduct("TEE", 0);
    const small = store.addVariant(product, "TEE-S", 5);
    square.addItem("Tee", [{ id: "V1", sku: "TEE-S", name: "S", count: 5 }]);
    pair(small, "V1", { agreed: 5 });
    square.sell("V1", 2);

    await sync();

    expect(store.level(small)).toBe(3);
    expect(store.stock.at(-1)).toMatchObject({ parent_id: product.id, variant_id: small.id, quantity: -2 });
  });

  it("shares the stock of one Swell location in a store that keeps stock by location", async () => {
    const product = store.addProduct("TEE", 5, { location: "shop" });
    store.adjust(product, 20, "received", "warehouse");
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 5 }]);
    pair(product, "V1", { agreed: 5, swell_location: "shop" });
    square.sell("V1", 1);

    await sync({ swellLocation: "shop" });

    expect(store.stock.at(-1)).toMatchObject({ quantity: -1, location: "shop" });
    expect(store.products[0].stock_locations).toEqual({ shop: { stock_level: 4 }, warehouse: { stock_level: 20 } });
    expect(square.count("V1")).toBe(4);
  });

  it("stops a pair when the Swell location it was started with is no longer the one in the settings", async () => {
    const product = store.addProduct("TEE", 5, { location: "shop" });
    store.adjust(product, 20, "received", "warehouse");
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 5 }]);
    pair(product, "V1", { agreed: 5, swell_location: "shop" });

    const outcome = await sync({ swellLocation: "warehouse" });

    expect(outcome.stopped).toBe(1);
    expect(square.count("V1")).toBe(5);
    expect(store.stock).toHaveLength(2);
  });

  it("stops a pair whose interrupted step was for another Swell location, and changes neither location", async () => {
    const product = store.addProduct("TEE", 10, { location: "shop" });
    store.adjust(product, 100, "received", "warehouse");
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 10 }]);
    pair(product, "V1", { agreed: 10, swell_location: "shop" });
    square.sell("V1", 1);
    // The step for the shop is written, and the run stops before Swell has its part
    store.failures.push({ when: (method, path) => method === "post" && path === "/products:stock", error: new Error("store unavailable") });
    await expect(sync({ swellLocation: "shop" })).rejects.toThrow("store unavailable");
    expect(store.links[0].pending).toBe(true);

    // The merchant chose the warehouse meanwhile
    const outcome = await sync({ swellLocation: "warehouse" });

    expect(outcome.stopped).toBe(1);
    expect(store.links[0]).toMatchObject({ status: "error", swell_location: "shop" });
    expect(store.products[0].stock_locations).toEqual({ shop: { stock_level: 10 }, warehouse: { stock_level: 100 } });
    expect(square.count("V1")).toBe(9);
  });

  it("leaves the pairs it has no time for untouched", async () => {
    const product = store.addProduct("TEE", 3);
    square.addItem("Tee", [{ id: "V1", sku: "TEE", count: 12 }]);
    pair(product, "V1", { agreed: 3, marked: true });

    const outcome = await sync({ deadline: Date.now() - 1 });

    expect(outcome).toMatchObject({ left: 1, checked: 0 });
    expect(store.links[0].marked).toBe(true);
    expect(store.level(product)).toBe(3);
  });
});
