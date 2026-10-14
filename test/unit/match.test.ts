import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropMissing, matchItems } from "../../functions/lib/match";
import type { MatchContext } from "../../functions/lib/match";
import { LOCATION, createSquare } from "../helpers/square";
import type { TestSquare } from "../helpers/square";
import { createStore } from "../helpers/store";
import type { TestStore } from "../helpers/store";

let store: TestStore;
let square: TestSquare;

const context = (): MatchContext => ({ swell: store.swell, api: { token: square.token, sandbox: true }, locationId: LOCATION });
const match = () => matchItems(context(), square.items);
const link = (sku: string) => store.links.find((record) => record.sku === sku);

beforeEach(() => {
  store = createStore();
  square = createSquare();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matching products by SKU", () => {
  it("pairs a Square variation with the one Swell product or variant that has its SKU, and moves no stock", async () => {
    const mug = store.addProduct("MUG", 4);
    const tee = store.addProduct("TEE", 0);
    const small = store.addVariant(tee, "TEE-S", 9);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    square.addItem("Tee", [{ id: "V2", sku: "TEE-S", name: "S", count: 2 }, { id: "V3", name: "M" }]);

    const outcome = await match();

    expect(outcome).toEqual({ matched: 2, unlinked: 0, without_sku: 1 });
    expect(link("MUG")).toMatchObject({ status: "ready", name: "Mug", product_id: mug.id, variant_id: null, swell_level: 4, square_level: 6, key: `${LOCATION}:V1` });
    expect(link("TEE-S")).toMatchObject({ status: "ready", name: "Tee – S", product_id: tee.id, variant_id: small.id, swell_name: "Product TEE – S" });
    expect(store.stock).toHaveLength(2);
    expect(square.adjustments).toHaveLength(0);
  });

  it("links nothing it would have to guess, and says why", async () => {
    store.addProduct("TWICE-IN-SQUARE", 1);
    store.addProduct("UNTRACKED-SWELL", 1, { stock_tracking: false });
    store.addProduct("UNTRACKED-SQUARE", 1);
    store.addProduct("BY-WEIGHT", 1);
    store.addVariant(store.addProduct("HAS-VARIANTS", 0), "HAS-VARIANTS-S", 1);
    store.addVariant(store.addProduct("PARENT", 0), "TWICE-IN-SWELL", 1);
    store.addProduct("TWICE-IN-SWELL", 1);
    square.addItem("A", [{ id: "V1", sku: "TWICE-IN-SQUARE", count: 1 }, { id: "V2", sku: "TWICE-IN-SQUARE", count: 1 }]);
    square.addItem("B", [
      { id: "V3", sku: "UNTRACKED-SWELL", count: 1 },
      { id: "V4", sku: "UNTRACKED-SQUARE", tracked: false },
      { id: "V5", sku: "BY-WEIGHT", count: 1, unit: true },
      { id: "V6", sku: "HAS-VARIANTS", count: 1 },
      { id: "V7", sku: "TWICE-IN-SWELL", count: 1 },
      { id: "V8", sku: "ONLY-IN-SQUARE", count: 1 },
    ]);

    const outcome = await match();

    expect(outcome).toMatchObject({ matched: 0, unlinked: 8 });
    expect(store.links.every((record) => record.status === "unlinked" && record.reason)).toBe(true);
    expect(link("UNTRACKED-SQUARE")?.reason).toContain("Square does not track stock");
    expect(link("ONLY-IN-SQUARE")).toMatchObject({ reason: "No Swell product or variant has this SKU.", product_id: null });
  });

  it("can be run again: a corrected item becomes a pair, and a pair in sync is left alone", async () => {
    const mug = store.addProduct("MUG", 4);
    store.addProduct("CAP", 2, { stock_tracking: false });
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    square.addItem("Cap", [{ id: "V2", sku: "CAP", count: 3 }]);
    await match();
    Object.assign(link("MUG")!, { status: "active", agreed: 6 });
    store.products[1].stock_tracking = true;
    square.items[0].item_data.name = "Mug, large";

    await match();
    await match();

    expect(store.links).toHaveLength(2);
    expect(link("CAP")).toMatchObject({ status: "ready", reason: null });
    expect(link("MUG")).toMatchObject({ status: "active", agreed: 6, name: "Mug, large", product_id: mug.id });
  });

  it("finds a second holder of a SKU on a later page of the catalog", async () => {
    store.addProduct("MUG", 4);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    await match();
    square.addItem("Mug again", [{ id: "V2", sku: "MUG", count: 1 }]);

    await matchItems(context(), [square.items[1]]);

    expect(store.links.map((record) => record.status)).toEqual(["unlinked", "unlinked"]);
  });

  it("does not link a second Square item to a Swell product another item holds", async () => {
    const mug = store.addProduct("MUG", 4);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    await match();
    Object.assign(link("MUG")!, { status: "active", agreed: 6 });
    // The SKU moved to another Square item; the first one is still in sync with the mug
    square.items[0].item_data.variations[0].item_variation_data.sku = "MUG-OLD";
    square.addItem("New mug", [{ id: "V2", sku: "MUG", count: 1 }]);

    await match();

    const second = store.links.find((record) => record.variation_id === "V2");
    expect(second).toMatchObject({ status: "unlinked", product_id: mug.id });
    expect(second?.reason).toContain("another Square item");
  });

  it("links the items of a new Square location although the old location's items still name the products", async () => {
    const mug = store.addProduct("MUG", 4);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    // Started at another location, then stopped when the location setting changed
    store.links.push({ id: store.nextId(), key: "OLD:V1", sku: "MUG", location_id: "OLD", variation_id: "V1", product_id: mug.id, variant_id: null, status: "error", agreed: 6 });

    await match();

    expect(store.links.find((record) => record.location_id === LOCATION)).toMatchObject({ status: "ready", product_id: mug.id });
  });

  it("forgets an item that was deleted in Square, and stops its sync if it had one", async () => {
    store.addProduct("MUG", 4);
    store.addProduct("CAP", 2);
    square.addItem("Mug", [{ id: "V1", sku: "MUG", count: 6 }]);
    square.addItem("Cap", [{ id: "V2", sku: "CAP", count: 3 }]);
    await match();
    link("CAP")!.status = "active";
    square.items[0].item_data.variations[0].is_deleted = true;
    square.items[1].item_data.variations[0].is_deleted = true;

    await dropMissing(context(), [...store.links]);

    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({ sku: "CAP", status: "error", reason: "The item was deleted in Square." });
  });
});
