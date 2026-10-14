import { vi } from "vitest";

type Row = Record<string, any>;

function value(row: Row, field: string): unknown {
  return field.split(".").reduce<any>((current, part) => (current === null || current === undefined ? undefined : current[part]), row) ?? null;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([field, expected]) => {
    if (field === "$or") {
      return (expected as Row[]).some((branch) => matches(row, branch));
    }
    if (field === "$and") {
      return (expected as Row[]).every((branch) => matches(row, branch));
    }
    const actual = value(row, field);
    if (expected === null || (expected && typeof expected === "object" && "$ne" in expected && expected.$ne === null)) {
      // The store receives a query as text, where null becomes "null" and matches nothing
      throw new Error(`A query compares ${field} with null, which the store receives as the text "null"`);
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected).every(([operator, operand]) => {
        switch (operator) {
          case "$ne":
            return actual !== (operand ?? null);
          case "$in":
            return (operand as unknown[]).includes(actual);
          case "$gt":
            return actual !== null && (actual as any) > (operand as any);
          case "$exists":
            return (actual !== null) === operand;
          default:
            throw new Error(`Operator ${operator} is not supported by the test store`);
        }
      });
    }
    return actual === (expected ?? null);
  });
}

const UNIQUE: Record<string, string> = { items: "key", sales: "key", state: "key", alerts: "key", accounts: "email", orders: "number" };

/**
 * An in-memory stand-in for the store API, as far as the app uses it: the app's collections,
 * products with their variants and stock entries, orders, accounts and settings.
 *
 * `mode` is how a refused write comes back: thrown, as in a function, or resolved with
 * `errors`, as in a workflow.
 */
export function createStore(seed: { settings?: Row; shipments?: Row; mode?: "function" | "workflow" } = {}) {
  const mode = seed.mode || "workflow";
  let sequence = 0;
  let clock = Math.floor(Date.now() / 1000) - 100000;
  const collections: Record<string, Row[]> = {
    items: [],
    sales: [],
    state: [],
    alerts: [],
    products: [],
    "products:variants": [],
    "products:stock": [],
    orders: [],
    accounts: [],
    payments: [],
  };
  let paymentSettings: Row = { methods: [{ id: "card", name: "Credit card", enabled: true }] };
  let settings: Row = seed.settings || {};
  /** Writes that asked for their events to be recorded: in a workflow, no others are */
  const events: string[] = [];
  /** Called once for the next write that matches, to make it fail as the store API would */
  const failures: { when: (method: string, path: string, data: Row) => boolean; error: Error }[] = [];
  /** Runs ended through the API */
  const terminated: string[] = [];
  /** Called after a stock entry changed a level, as the store raises product.stock_adjusted */
  const stockAdjusted: ((change: Row) => void)[] = [];

  // Ids grow with time, like the store's own
  function nextId(): string {
    sequence += 1;
    clock += 1;
    return clock.toString(16).padStart(8, "0") + sequence.toString(16).padStart(16, "0");
  }

  function refuse(errors: Row): never | Row {
    if (mode === "function") {
      throw Object.assign(new Error("Validation failed"), { status: 400, body: errors });
    }
    return { errors };
  }

  function recalculate(productId: string, variantId: string | null): void {
    const entries = collections["products:stock"].filter((entry) => entry.parent_id === productId && (entry.variant_id || null) === variantId);
    const record = variantId ? collections["products:variants"].find((row) => row.id === variantId) : collections.products.find((row) => row.id === productId);
    if (!record) {
      return;
    }
    const previous = record.stock_level || 0;
    const locations: Row = {};
    let total = 0;
    for (const entry of entries) {
      total += entry.quantity;
      if (entry.location) {
        locations[entry.location] = { stock_level: (locations[entry.location]?.stock_level || 0) + entry.quantity };
      }
    }
    record.stock_level = total;
    record.stock_locations = locations;
    if (previous !== total) {
      for (const listener of stockAdjusted) {
        listener({
          id: productId,
          $event: { data: variantId ? { variant_id: variantId, variant_stock_level: total, prev_variant_stock_level: previous } : { stock_level: total, prev_stock_level: previous } },
        });
      }
    }
  }

  function createOrder(data: Row): Row {
    if (!data.account_id) {
      return refuse({ account_id: { code: "REQUIRED", message: "Required" } });
    }
    const items = (data.items || []) as Row[];
    if (items.some((item) => !item.product_id && !item.description)) {
      return refuse({ "items.product_id": { code: "REQUIRED", message: "Item product_id or description is required" } });
    }
    if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1)) {
      return refuse({ "items.quantity": { code: "MIN", message: "Must be at least 1" } });
    }
    const sum = (list: Row[] | undefined) => (list || []).reduce((total, entry) => total + (entry.amount || 0), 0);
    const subTotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
    const discount = items.reduce((total, item) => total + sum(item.discounts), 0);
    const tax = items.reduce((total, item) => total + sum(item.taxes), 0);
    const grandTotal = Number((subTotal - discount + (data.item_tax_included ? 0 : tax)).toFixed(4));
    return {
      ...data,
      number: data.number || String(100000 + collections.orders.length),
      sub_total: subTotal,
      discount_total: discount,
      tax_total: tax,
      grand_total: Number(grandTotal.toFixed(2)),
      payment_total: 0,
      refund_total: 0,
      paid: false,
      refunded: false,
      status: "payment_pending",
    };
  }

  /** The order's money follows its payment records, as the store's formulas have it */
  function settle(orderId: string): void {
    const order = collections.orders.find((row) => row.id === orderId);
    if (!order) {
      return;
    }
    const payments = collections.payments.filter((payment) => payment.order_id === orderId);
    order.payment_total = Number(payments.reduce((sum, payment) => sum + payment.amount, 0).toFixed(2));
    order.refund_total = Number(payments.reduce((sum, payment) => sum + (payment.refunds || []).reduce((part: number, refund: Row) => part + refund.amount, 0), 0).toFixed(2));
    order.paid = order.payment_total > 0 && order.payment_total - order.refund_total >= order.grand_total - order.refund_total;
    order.refunded = order.refund_total > 0 && order.refund_total >= order.payment_total;
    order.status = order.paid ? "complete" : "payment_pending";
  }

  function failing(method: string, path: string, data: Row): Error | undefined {
    const index = failures.findIndex((failure) => failure.when(method, path, data));
    return index >= 0 ? failures.splice(index, 1)[0].error : undefined;
  }

  function locate(path: string): { name: string; id?: string } {
    const [, name, id] = path.split("/");
    if (!collections[name]) {
      throw new Error(`Unexpected request to ${path}`);
    }
    return { name, id };
  }

  const swell = {
    settings: vi.fn(async () => settings),
    get: vi.fn(async (path: string, query: Row = {}) => {
      if (path === "/settings/shipments") {
        return seed.shipments || { features: { multi_location: false }, locations: [] };
      }
      if (path === "/settings/payments") {
        return paymentSettings;
      }
      const refund = /^\/payments\/([^/]+)\/refunds\/([^/]+)$/.exec(path);
      if (refund) {
        const found = collections.payments.find((row) => row.id === refund[1])?.refunds?.find((row: Row) => row.id === refund[2]);
        return found ? { ...found } : "";
      }
      const { name, id } = locate(path);
      if (id) {
        const row = collections[name].find((item) => item.id === id);
        return row ? { ...row } : "";
      }
      const where = { ...(query.where || {}), ...(query.$and ? { $and: query.$and } : {}), ...(query.$or ? { $or: query.$or } : {}) };
      let found = collections[name].filter((row) => matches(row, where));
      if (query.sort === "id asc") {
        found = [...found].sort((a, b) => (a.id < b.id ? -1 : 1));
      }
      return { count: found.length, results: found.slice(0, query.limit || 15).map((row) => ({ ...row })) };
    }),
    post: vi.fn(async (path: string, body: Row) => {
      if (path === "/:workflows/instances/terminate") {
        terminated.push(body.instance_id);
        return { id: body.instance_id, status: "terminated" };
      }
      const refund = /^\/payments\/([^/]+)\/refunds$/.exec(path);
      if (refund) {
        const failure = failing("post", path, body);
        if (failure) {
          throw failure;
        }
        const { $events, $notify, ...data } = body;
        const payment = collections.payments.find((row) => row.id === refund[1]);
        if (!payment) {
          return "";
        }
        if ($notify !== false) {
          throw new Error("A refund record must not notify");
        }
        // As the store does, also for a refund posted again under its id
        const refunded = (payment.refunds || []).reduce((sum: number, row: Row) => sum + row.amount, 0);
        if (data.amount > payment.amount - refunded + 1e-9) {
          return refuse({ amount: { code: "INVALID", message: "Refund cannot exceed payment amount" } });
        }
        payment.refunds = [...(payment.refunds || []).filter((row: Row) => row.id !== data.id), { ...data, method: payment.method, success: true }];
        settle(payment.order_id);
        return { ...data };
      }
      const { name } = locate(path);
      const { $events, $notify, $payment, $combine_items, ...data } = body;
      const failure = failing("post", path, body);
      if (failure) {
        throw failure;
      }
      const unique = UNIQUE[name];
      if (unique && data[unique] && collections[name].some((row) => row[unique] === data[unique] && row.id !== data.id)) {
        return refuse({ [unique]: { code: "UNIQUE", message: "Already exists" } });
      }
      let row: Row = { ...data, id: data.id || nextId(), date_created: data.date_created || new Date().toISOString() };
      if (name === "orders") {
        row = createOrder(row);
        if (row.errors) {
          return row;
        }
        if ($notify !== false || $payment !== false || $combine_items !== false) {
          throw new Error("An imported order must not notify, charge or merge lines");
        }
      }
      if (name === "payments") {
        if (!paymentSettings.methods.some((method: Row) => method.id === row.method)) {
          return refuse({ method: { code: "INVALID", message: `Payment method '${row.method}' is not enabled` } });
        }
        if ($notify !== false) {
          throw new Error("A payment record must not notify");
        }
        row.success = true;
      }
      if (name === "products:stock" && (!Number.isInteger(row.quantity) || !row.parent_id)) {
        return refuse({ quantity: { code: "REQUIRED", message: "Required" } });
      }
      if ($events === true) {
        events.push(`created ${path}`);
      }
      // A record posted under an id that exists replaces it, as the store does
      const existing = collections[name].findIndex((item) => item.id === row.id);
      if (existing >= 0) {
        collections[name][existing] = { ...collections[name][existing], ...row };
      } else {
        collections[name].push(row);
      }
      if (name === "products:stock") {
        recalculate(row.parent_id, row.variant_id || null);
      }
      if (name === "payments") {
        settle(row.order_id);
      }
      return { ...row };
    }),
    put: vi.fn(async (path: string, body: Row) => {
      const [, first, second] = path.split("/");
      if (first === "settings" && second === "payments") {
        // Elements with an id are merged by id, unknown ones appended
        for (const method of body.methods || []) {
          paymentSettings.methods = [...paymentSettings.methods.filter((known: Row) => known.id !== method.id), method];
        }
        return paymentSettings;
      }
      if (first === "settings") {
        const merged: Row = { ...settings };
        for (const [group, values] of Object.entries(body)) {
          merged[group] = { ...(settings[group] || {}), ...(values as Row) };
        }
        settings = merged;
        return settings;
      }
      const { name } = locate(path);
      const failure = failing("put", path, body);
      if (failure) {
        throw failure;
      }
      const row = collections[name].find((item) => item.id === second);
      if (!row) {
        return "";
      }
      const { $events, $notify, $app, ...changes } = body;
      if ($events === true) {
        events.push(`updated ${path}`);
      }
      Object.assign(row, changes);
      if ($app) {
        row.$app = row.$app || {};
        for (const [app, values] of Object.entries($app as Row)) {
          row.$app[app] = { ...(row.$app[app] || {}), ...(values as Row) };
        }
      }
      return { ...row };
    }),
    delete: vi.fn(async (path: string) => {
      const { name, id } = locate(path);
      const index = collections[name].findIndex((row) => row.id === id);
      if (index >= 0) {
        collections[name].splice(index, 1);
      }
      return {};
    }),
  };

  /** The runs the app asked for */
  const runs: { name: string; data: Row }[] = [];
  const workflows = {
    create: vi.fn(async (name: string, data: Row) => {
      runs.push({ name, data });
      return { id: `wf_inst_${runs.length}`, status: "active" };
    }),
  };

  return {
    swell: { ...swell, workflows },
    /** The app's `items` collection: the pairs of a Square variation and a Swell product or variant */
    links: collections.items,
    sales: collections.sales,
    state: collections.state,
    alerts: collections.alerts,
    products: collections.products,
    orders: collections.orders,
    accounts: collections.accounts,
    payments: collections.payments,
    get paymentMethods(): Row[] {
      return paymentSettings.methods;
    },
    /** As Test connection leaves it: the Square POS payment method is there */
    addPaymentMethod() {
      paymentSettings.methods.push({ id: "square_pos", name: "Square POS", manual: true, enabled: false });
    },
    stock: collections["products:stock"],
    variants: collections["products:variants"],
    runs,
    terminated,
    events,
    failures,
    stockAdjusted,
    nextId,
    get settings() {
      return settings;
    },
    set settings(next: Row) {
      settings = next;
    },
    /** A product without variants that tracks stock, with a starting quantity */
    addProduct(sku: string, level: number, extra: Row = {}): Row {
      const product: Row = { id: nextId(), name: `Product ${sku}`, sku, stock_tracking: true, stock_level: 0, ...extra };
      collections.products.push(product);
      if (level !== 0) {
        collections["products:stock"].push({ id: nextId(), parent_id: product.id, variant_id: null, quantity: level, reason: "received", date_created: "2026-01-01T00:00:00.000Z", ...(extra.location ? { location: extra.location } : {}) });
        recalculate(product.id, null);
      }
      return product;
    },
    /** A variant of a product with options, with its own SKU and stock */
    addVariant(product: Row, sku: string, level: number): Row {
      product.options = [{ name: "Size", variant: true }];
      const variant: Row = { id: nextId(), parent_id: product.id, name: sku.split("-").pop(), sku, stock_level: 0 };
      collections["products:variants"].push(variant);
      if (level !== 0) {
        collections["products:stock"].push({ id: nextId(), parent_id: product.id, variant_id: variant.id, quantity: level, reason: "received", date_created: "2026-01-01T00:00:00.000Z" });
        recalculate(product.id, variant.id);
      }
      return variant;
    },
    /** A stock change made in Swell: an order, a delivery, a correction */
    adjust(record: Row, quantity: number, reason: string, location?: string): Row {
      const entry: Row = {
        id: nextId(),
        parent_id: record.parent_id || record.id,
        variant_id: record.parent_id ? record.id : null,
        quantity,
        reason,
        date_created: new Date().toISOString(),
        ...(location ? { location } : {}),
      };
      collections["products:stock"].push(entry);
      recalculate(entry.parent_id, entry.variant_id);
      return entry;
    },
    level(record: Row): number {
      const rows = record.parent_id ? collections["products:variants"] : collections.products;
      return rows.find((row) => row.id === record.id)?.stock_level || 0;
    },
  };
}

export type TestStore = ReturnType<typeof createStore>;
