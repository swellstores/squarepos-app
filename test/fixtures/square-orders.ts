/**
 * Square orders as the sandbox answered them on 2026-10-13 (API version 2026-09-16),
 * shortened to the fields the app reads.
 */

const LOCATION = "LWFM7F2KQV64X";

/** Two lines, one from the catalog and one custom amount, a 10 % order discount and 8.5 % tax on top; paid in cash */
export const cashSale = {
  id: "n0EgwiYVAQo5XwyZHfYXHgItGePZY",
  location_id: LOCATION,
  line_items: [
    {
      uid: "LkMSmFOk2QC8bfWX3wfQIC",
      catalog_object_id: "LXUGUJ2CVSTGKBZN7N7FQP52",
      quantity: "2",
      name: "Swell sync test tee",
      variation_name: "S",
      base_price_money: { amount: 2000, currency: "USD" },
      gross_sales_money: { amount: 4000, currency: "USD" },
      total_tax_money: { amount: 306, currency: "USD" },
      total_discount_money: { amount: 400, currency: "USD" },
      total_money: { amount: 3906, currency: "USD" },
      applied_taxes: [{ uid: "9z9J", tax_uid: "t1", applied_money: { amount: 306, currency: "USD" } }],
      applied_discounts: [{ uid: "HoOu", discount_uid: "d1", applied_money: { amount: 400, currency: "USD" } }],
      item_type: "ITEM",
      total_service_charge_money: { amount: 0, currency: "USD" },
    },
    {
      uid: "Q04UWMs5oEqisoMciHqvnB",
      quantity: "1",
      name: "Custom amount thing",
      base_price_money: { amount: 350, currency: "USD" },
      gross_sales_money: { amount: 350, currency: "USD" },
      total_tax_money: { amount: 27, currency: "USD" },
      total_discount_money: { amount: 35, currency: "USD" },
      total_money: { amount: 342, currency: "USD" },
      applied_taxes: [{ uid: "6V8e", tax_uid: "t1", applied_money: { amount: 27, currency: "USD" } }],
      applied_discounts: [{ uid: "Br5b", discount_uid: "d1", applied_money: { amount: 35, currency: "USD" } }],
      item_type: "ITEM",
      total_service_charge_money: { amount: 0, currency: "USD" },
    },
  ],
  taxes: [{ uid: "t1", name: "Sales tax", percentage: "8.5", type: "ADDITIVE", applied_money: { amount: 333, currency: "USD" }, scope: "ORDER" }],
  discounts: [{ uid: "d1", name: "Staff 10%", percentage: "10", applied_money: { amount: 435, currency: "USD" }, type: "FIXED_PERCENTAGE", scope: "ORDER" }],
  created_at: "2026-10-13T18:18:33.460Z",
  updated_at: "2026-10-13T18:18:34.328Z",
  state: "COMPLETED",
  version: 3,
  total_tax_money: { amount: 333, currency: "USD" },
  total_discount_money: { amount: 435, currency: "USD" },
  total_tip_money: { amount: 0, currency: "USD" },
  total_money: { amount: 4248, currency: "USD" },
  closed_at: "2026-10-13T18:18:34.367Z",
  tenders: [
    {
      id: "snXTy4YlfjpQ78i43z6dXDhZzwHZY",
      location_id: LOCATION,
      amount_money: { amount: 4248, currency: "USD" },
      type: "CASH",
      cash_details: { buyer_tendered_money: { amount: 4248, currency: "USD" }, change_back_money: { amount: 0, currency: "USD" } },
      payment_id: "snXTy4YlfjpQ78i43z6dXDhZzwHZY",
    },
  ],
  total_service_charge_money: { amount: 0, currency: "USD" },
  source: { name: "Sandbox for sq0idp-uVHSVL7r7rRgU783cSYpiQ" },
};

/** One catalog line without tax, paid by card */
export const cardSale = {
  id: "veh94g89WCpiZ2vWk2QcxGZx9gGZY",
  location_id: LOCATION,
  line_items: [
    {
      uid: "card-line-1",
      catalog_object_id: "LXUGUJ2CVSTGKBZN7N7FQP52",
      quantity: "1",
      name: "Swell sync test tee",
      variation_name: "S",
      base_price_money: { amount: 2000, currency: "USD" },
      gross_sales_money: { amount: 2000, currency: "USD" },
      total_tax_money: { amount: 0, currency: "USD" },
      total_discount_money: { amount: 0, currency: "USD" },
      total_money: { amount: 2000, currency: "USD" },
      item_type: "ITEM",
    },
  ],
  created_at: "2026-10-13T18:19:56.000Z",
  updated_at: "2026-10-13T18:20:06.922Z",
  state: "COMPLETED",
  total_tax_money: { amount: 0, currency: "USD" },
  total_discount_money: { amount: 0, currency: "USD" },
  total_tip_money: { amount: 0, currency: "USD" },
  total_money: { amount: 2000, currency: "USD" },
  closed_at: "2026-10-13T18:19:57.399Z",
  tenders: [
    {
      id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
      location_id: LOCATION,
      amount_money: { amount: 2000, currency: "USD" },
      type: "CARD",
      card_details: { status: "CAPTURED", card: { card_brand: "VISA", last_4: "5858" }, entry_method: "KEYED" },
      payment_id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
    },
  ],
  source: { name: "Sandbox for sq0idp-uVHSVL7r7rRgU783cSYpiQ" },
};

/** The order Square created for a refund of 5.00 on the card sale: no lines, a return that points at the sale */
export const refundOrder = {
  id: "JnLNdSLvmIjyRbyMpLCLqMPc0aLZY",
  location_id: LOCATION,
  created_at: "2026-10-13T18:20:02.094Z",
  updated_at: "2026-10-13T18:20:02.518Z",
  state: "COMPLETED",
  closed_at: "2026-10-13T18:20:02.520Z",
  returns: [
    {
      uid: "4H9T0rjI5GpxcKOZf16XbB",
      source_order_id: "veh94g89WCpiZ2vWk2QcxGZx9gGZY",
      return_line_items: [
        {
          uid: "gpe2eMGPDE5ttm4GUo70KB",
          quantity: "1",
          item_type: "CUSTOM_AMOUNT",
          base_price_money: { amount: 500, currency: "USD" },
          total_money: { amount: 500, currency: "USD" },
        },
      ],
      return_amounts: { total_money: { amount: 500, currency: "USD" } },
    },
  ],
  return_amounts: { total_money: { amount: 500, currency: "USD" } },
  net_amounts: { total_money: { amount: -500, currency: "USD" } },
  refunds: [
    {
      id: "LRDcBVZS6KOdtwhjHr3RMjcXuWYXIpnJzBaS1PtHGZH",
      location_id: LOCATION,
      transaction_id: "veh94g89WCpiZ2vWk2QcxGZx9gGZY",
      tender_id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
      created_at: "2026-10-13T18:20:02.281Z",
      reason: "partial refund test",
      amount_money: { amount: 500, currency: "USD" },
      status: "APPROVED",
    },
  ],
};

export const cardPayment = {
  id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
  created_at: "2026-10-13T18:19:57.097Z",
  updated_at: "2026-10-13T18:20:05.937Z",
  amount_money: { amount: 2000, currency: "USD" },
  refunded_money: { amount: 500, currency: "USD" },
  status: "COMPLETED",
  source_type: "CARD",
  card_details: { status: "CAPTURED", card: { card_brand: "VISA", last_4: "5858" } },
  location_id: LOCATION,
  order_id: "veh94g89WCpiZ2vWk2QcxGZx9gGZY",
  total_money: { amount: 2000, currency: "USD" },
  receipt_number: "eQj3",
  receipt_url: "https://squareupsandbox.com/receipt/preview/eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
  application_details: { square_product: "ECOMMERCE_API", application_id: "sandbox-sq0idb-Q0jud5ewYCIi1Ux5IL1whA" },
};

/** The same payment after the refund of 5.00: it names the refund, and Square answers for it as below */
export const refundedCardPayment = {
  ...cardPayment,
  refund_ids: ["eQj3XSEycwGlkvOZRxvoDXZ3TUdZY_LRDcBVZS6KOdtwhjHr3RMjcXuWYXIpnJzBaS1PtHGZH"],
};

export const cardRefund = {
  id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY_LRDcBVZS6KOdtwhjHr3RMjcXuWYXIpnJzBaS1PtHGZH",
  status: "COMPLETED",
  amount_money: { amount: 500, currency: "USD" },
  payment_id: "eQj3XSEycwGlkvOZRxvoDXZ3TUdZY",
  order_id: "JnLNdSLvmIjyRbyMpLCLqMPc0aLZY",
  reason: "partial refund test",
  created_at: "2026-10-13T18:20:02.281Z",
  location_id: LOCATION,
};
