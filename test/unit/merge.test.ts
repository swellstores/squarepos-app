import { describe, expect, it } from "vitest";
import { plan, squareAdjustments, squareParts, startingPoint, swellEntry, wholeQuantity } from "../../functions/lib/merge";

describe("the stock merge", () => {
  it("passes on what each side did since the last sync", () => {
    // Agreed on 10. One sold online, two sold at the till, at the same time
    expect(plan(10, 9, 8)).toEqual({ toSquare: -1, toSwell: -2, agreed: 7 });
    // A delivery booked in Square while an online order was canceled
    expect(plan(4, 5, 24)).toEqual({ toSquare: 1, toSwell: 20, agreed: 25 });
  });

  it("does nothing when both sides hold what they agreed on", () => {
    expect(plan(7, 7, 7)).toEqual({ toSquare: 0, toSwell: 0, agreed: 7 });
  });

  it("lets both sides sell the last unit and shows the result below zero", () => {
    expect(plan(1, 0, 0)).toEqual({ toSquare: -1, toSwell: -1, agreed: -1 });
  });

  it("gives the other side the difference when a pair starts", () => {
    // Square is right: Swell 3, Square 12
    const fromSquare = startingPoint("square", 3, 12);
    expect(plan(fromSquare, 3, 12)).toEqual({ toSquare: 0, toSwell: 9, agreed: 12 });
    // Swell is right
    const fromSwell = startingPoint("swell", 3, 12);
    expect(plan(fromSwell, 3, 12)).toEqual({ toSquare: -9, toSwell: 0, agreed: 3 });
  });

  it("reads Square's quantity text and refuses fractions", () => {
    expect(wholeQuantity("5")).toBe(5);
    expect(wholeQuantity("5.00000")).toBe(5);
    expect(wholeQuantity("-2")).toBe(-2);
    expect(wholeQuantity("1.5")).toBeUndefined();
    expect(wholeQuantity("")).toBeUndefined();
    expect(wholeQuantity(undefined)).toBeUndefined();
  });
});

describe("a Swell change told to Square", () => {
  it("is sent by kind when the stock entries add up to it", () => {
    const parts = squareParts(-2, [
      { quantity: -3, reason: "sold" },
      { quantity: -1, reason: "damaged" },
      { quantity: 2, reason: "received" },
    ]);
    expect(parts).toEqual([
      { from_state: "NONE", to_state: "IN_STOCK", quantity: 2 },
      { from_state: "IN_STOCK", to_state: "SOLD", quantity: 3 },
      { from_state: "IN_STOCK", to_state: "WASTE", quantity: 1 },
    ]);
  });

  it("is sent as one neutral adjustment when the entries do not explain it", () => {
    expect(squareParts(-4, [{ quantity: -1, reason: "sold" }])).toEqual([{ from_state: "IN_STOCK", to_state: "NONE", quantity: 4 }]);
    expect(squareParts(3, [])).toEqual([{ from_state: "NONE", to_state: "IN_STOCK", quantity: 3 }]);
    expect(squareParts(0, [{ quantity: -1, reason: "sold" }])).toEqual([]);
  });

  it("names the step in every adjustment", () => {
    const adjustments = squareAdjustments("swell:abc:4", "VAR1", squareParts(-1, [{ quantity: -1, reason: "sold" }]));
    expect(adjustments).toEqual([
      { reference_id: "swell:abc:4:0", catalog_object_id: "VAR1", from_state: "IN_STOCK", to_state: "SOLD", quantity: 1 },
    ]);
  });
});

describe("a Square change written to Swell", () => {
  const sale = { from_state: "IN_STOCK", to_state: "SOLD", quantity: "2", transaction_id: "order1" };

  it("says what happened when Square's adjustments add up to it", () => {
    expect(swellEntry(-2, [sale], "swell:")).toEqual({ reason: "sold", message: "Square POS: 2 sold" });
    expect(swellEntry(8, [sale, { from_state: "NONE", to_state: "IN_STOCK", quantity: "10" }], "swell:")).toEqual({
      reason: "received",
      message: "Square POS: 2 sold, 10 received",
    });
    expect(swellEntry(-3, [{ from_state: "IN_STOCK", to_state: "WASTE", quantity: "3", physical_count_id: "pc1" }], "swell:")).toEqual({
      reason: "missing",
      message: "Square POS: 3 removed by a recount",
    });
  });

  it("leaves out the app's own adjustments", () => {
    const own = { from_state: "IN_STOCK", to_state: "SOLD", quantity: "1", reference_id: "swell:abc:4:0" };
    expect(swellEntry(-2, [own, sale], "swell:")).toEqual({ reason: "sold", message: "Square POS: 2 sold" });
  });

  it("only names the source when the adjustments do not explain the difference", () => {
    expect(swellEntry(-5, [sale], "swell:")).toEqual({ reason: "missing", message: "Square POS: stock changed in Square" });
    expect(swellEntry(4, [], "swell:")).toEqual({ reason: "received", message: "Square POS: stock changed in Square" });
  });
});
