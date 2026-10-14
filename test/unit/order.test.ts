import { describe, expect, it } from "vitest";
import { buildOrder, kindOf, mergeRefunds, refundsBySale, tenderText, toAmount } from "../../functions/lib/order";
import type { OrderContext } from "../../functions/lib/order";
import { cardPayment, cardSale, cashSale, refundOrder } from "../fixtures/square-orders";

type Row = Record<string, any>;

const context: OrderContext = {
  appId: "squarepos",
  id: "a".repeat(24),
  number: "SQ-eQj3",
  accountId: "b".repeat(24),
  locationName: "Main Street",
  announce: false,
};

const usd = (amount: number) => ({ amount, currency: "USD" });

function built(order: Row, extra: Partial<OrderContext> = {}): Row {
  const result = buildOrder(order, { ...context, ...extra });
  if ("problem" in result) {
    throw new Error(result.problem);
  }
  return result.order;
}

/** The total Swell computes from the lines, as its order formulas do */
function swellTotal(order: Row): number {
  const sum = (list: Row[] | undefined) => (list || []).reduce((total, entry) => total + entry.amount, 0);
  const items = order.items as Row[];
  const total = items.reduce((all, item) => all + item.price * item.quantity - sum(item.discounts) + (order.item_tax_included ? 0 : sum(item.taxes)), 0);
  return Number(total.toFixed(2));
}

describe("a Square sale as a Swell order", () => {
  it("copies the receipt: lines, discount and tax as Square charged them", () => {
    const order = built(cashSale);

    expect(order.items).toEqual([
      {
        description: "Swell sync test tee – S",
        product_name: "Swell sync test tee",
        variant_name: "S",
        quantity: 2,
        price: 20,
        discounts: [{ id: "square-d1", amount: 4 }],
        taxes: [{ id: "square-t1", amount: 3.06 }],
        metadata: { square_variation_id: "LXUGUJ2CVSTGKBZN7N7FQP52" },
      },
      {
        description: "Custom amount thing",
        product_name: "Custom amount thing",
        quantity: 1,
        price: 3.5,
        discounts: [{ id: "square-d1", amount: 0.35 }],
        taxes: [{ id: "square-t1", amount: 0.27 }],
      },
    ]);
    expect(order.taxes).toEqual([{ id: "square-t1", name: "Sales tax", rate: 8.5, amount: 3.33 }]);
    expect(order.discounts).toEqual([{ id: "square-d1", type: "sale", amount: 4.35 }]);
    expect(swellTotal(order)).toBe(42.48);
    expect(order).toMatchObject({ currency: "USD", date_created: "2026-10-13T18:18:34.367Z", item_tax_included: false });
  });

  it("is paid, silent, and tied to nothing that could change it", () => {
    const order = built(cardSale, { payment: cardPayment });

    // No line names a product: the order takes no stock
    expect(order.items.every((item: Row) => !("product_id" in item))).toBe(true);
    expect(order).toMatchObject({
      id: context.id,
      number: "SQ-eQj3",
      account_id: context.accountId,
      account_info_saved: false,
      taxes_fixed: true,
      $notify: false,
      $payment: false,
      $combine_items: false,
    });
    expect(order.$events).toBeUndefined();
    expect(order.payment_marked).toBeUndefined();
    expect(order.$app.squarepos).toMatchObject({ square_order_id: cardSale.id, receipt_number: "eQj3", location_name: "Main Street", tender: "Card (Visa 5858)" });
    expect(built(cardSale, { announce: true }).$events).toBe(true);
  });

  it("keeps a tax that is part of the prices out of the total", () => {
    const order = built({
      ...cardSale,
      line_items: [{ ...cardSale.line_items[0], total_tax_money: usd(167), applied_taxes: [{ tax_uid: "vat", applied_money: usd(167) }] }],
      taxes: [{ uid: "vat", name: "VAT", percentage: "9.1", type: "INCLUSIVE", applied_money: usd(167) }],
    });

    expect(order.item_tax_included).toBe(true);
    expect(order.items[0].taxes).toEqual([{ id: "square-vat", amount: 1.67 }]);
    expect(swellTotal(order)).toBe(20);
  });

  it("adds a tip, a service charge and cash rounding so that the total is what was paid", () => {
    const order = built({
      ...cardSale,
      service_charges: [{ name: "Delivery", applied_money: usd(300), applied_taxes: [{ tax_uid: "t1", applied_money: usd(26) }] }],
      taxes: [{ uid: "t1", name: "Sales tax", percentage: "8.5", type: "ADDITIVE", applied_money: usd(26) }],
      total_tip_money: usd(250),
      rounding_adjustment: { name: "Rounding", amount_money: usd(-1) },
      total_money: usd(2000 + 300 + 26 + 250 - 1),
    });

    expect(order.items.map((item: Row) => [item.description, item.price])).toEqual([
      ["Swell sync test tee – S", 20],
      ["Delivery", 3],
      ["Tip", 2.5],
    ]);
    expect(order.items[0].discounts).toEqual([{ id: "square-rounding", amount: 0.01 }]);
    expect(swellTotal(order)).toBe(25.75);
  });

  it("makes one unit of a line whose quantity is a weight or whose price does not divide", () => {
    const order = built({
      ...cardSale,
      line_items: [
        { name: "Cheese", quantity: "0.35", base_price_money: usd(2400), gross_sales_money: usd(840), total_money: usd(840) },
        { name: "Three for ten", quantity: "3", gross_sales_money: usd(1000), total_money: usd(1000) },
      ],
      total_money: usd(1840),
    });

    expect(order.items).toMatchObject([
      { description: "0.35 × Cheese", quantity: 1, price: 8.4 },
      { description: "3 × Three for ten", quantity: 1, price: 10 },
    ]);
  });

  it("is not built when its lines do not add up to Square's total", () => {
    const result = buildOrder({ ...cardSale, total_money: usd(2050) }, context);

    expect("problem" in result && result.problem).toContain("20.50 USD");
  });

  it("counts money in the currency's own unit", () => {
    expect(toAmount(4248, "USD")).toBe(42.48);
    expect(toAmount(4248, "JPY")).toBe(4248);
    expect(toAmount(4248, "KWD")).toBe(4.248);
  });
});

describe("what a Square order is", () => {
  it("tells sales, refunds and exchanges apart", () => {
    expect(kindOf(cashSale)).toBe("sale");
    expect(kindOf(refundOrder)).toBe("refund");
    expect(kindOf({ ...cashSale, returns: refundOrder.returns })).toBe("exchange");
    expect(kindOf({ ...cashSale, state: "OPEN" })).toBe("other");
  });

  it("names how it was paid", () => {
    expect(tenderText(cashSale)).toBe("Cash");
    expect(tenderText({ tenders: [...cardSale.tenders, ...cashSale.tenders] })).toBe("Card (Visa 5858), Cash");
  });
});

describe("refunds", () => {
  it("are read from Square's refund order for the sale it points at", () => {
    expect([...refundsBySale(refundOrder)]).toEqual([
      [cardSale.id, [{ id: "LRDcBVZS6KOdtwhjHr3RMjcXuWYXIpnJzBaS1PtHGZH", tender_id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY", amount: 5, reason: "partial refund test", date: "2026-10-13T18:20:02.281Z" }]],
    ]);
    const rejected = { ...refundOrder, refunds: [{ ...refundOrder.refunds[0], status: "REJECTED" }] };
    expect(refundsBySale(rejected).size).toBe(0);
  });

  it("add up on the sale, each counted once", () => {
    const first = mergeRefunds([], [{ id: "r1", amount: 5 }], 20);
    expect(first).toMatchObject({ refunded: 5, refund_state: "partial" });
    expect(mergeRefunds(first!.refunds, [{ id: "r1", amount: 5 }], 20)).toBeUndefined();
    expect(mergeRefunds(first!.refunds, [{ id: "r2", amount: 15 }], 20)).toMatchObject({ refunded: 20, refund_state: "full" });
  });
});
