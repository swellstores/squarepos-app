import { vi } from "vitest";

type Row = Record<string, any>;

export interface SquareCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function refused(status: number, code: string, detail: string, field?: string): Response {
  return json(status, { errors: [{ category: status === 401 ? "AUTHENTICATION_ERROR" : "INVALID_REQUEST_ERROR", code, detail, ...(field ? { field } : {}) }] });
}

export const LOCATION = "LOC1";

/**
 * Replaces `fetch` with a small Square, behaving as the sandbox did on 2026-10-13: counts
 * that move by adjustments, a request key that answers a repeated request as the first
 * time and refuses another body, a variation without a count until it is counted, orders
 * found by their time of change. `intercept` can answer any call differently, to play
 * refusals and outages.
 */
export function createSquare(options: { token?: string; locations?: Row[] } = {}) {
  const token = options.token || "sandbox-token";
  const locations = options.locations || [{ id: LOCATION, name: "Main Street", status: "ACTIVE", currency: "USD" }];
  const items: Row[] = [];
  const counts = new Map<string, number>();
  const adjustments: Row[] = [];
  const keys = new Map<string, { body: string; answer: Row }>();
  const orders: Row[] = [];
  const payments: Row[] = [];
  const customers: Row[] = [];
  const refunds: Row[] = [];
  const subscriptions: Row[] = [];
  const calls: SquareCall[] = [];
  let sequence = 0;
  let intercept: ((call: SquareCall) => Response | undefined) | undefined;

  /** Where the shop's stock is counted */
  const home: string = locations[0].id;
  const countKey = (variationId: string, locationId = home) => `${locationId}:${variationId}`;

  function apply(adjustment: Row): void {
    const quantity = Number(adjustment.quantity);
    const key = countKey(adjustment.catalog_object_id, adjustment.to_location_id || adjustment.from_location_id);
    const current = counts.get(key) || 0;
    if (adjustment.to_state === "IN_STOCK" && adjustment.from_state !== "IN_STOCK") {
      counts.set(key, current + quantity);
    } else if (adjustment.from_state === "IN_STOCK") {
      counts.set(key, current - quantity);
    }
    sequence += 1;
    adjustments.push({ id: `adj${sequence}`, created_at: new Date().toISOString(), ...adjustment });
  }

  function countsOf(variationIds: string[], locationIds: string[]): Row[] {
    const found: Row[] = [];
    for (const variationId of variationIds) {
      for (const locationId of locationIds) {
        const quantity = counts.get(countKey(variationId, locationId));
        if (quantity !== undefined) {
          found.push({ catalog_object_id: variationId, catalog_object_type: "ITEM_VARIATION", state: "IN_STOCK", location_id: locationId, quantity: String(quantity), calculated_at: new Date().toISOString() });
        }
      }
    }
    return found;
  }

  function handle(call: SquareCall): Response {
    const { method, path, body, query } = call;
    if (path === "/merchants/me") {
      return json(200, { merchant: { id: "M1", business_name: "Alder & Co.", country: "US", currency: "USD", main_location_id: locations[0].id } });
    }
    if (path === "/locations") {
      return json(200, { locations });
    }
    if (path === "/catalog/list") {
      const from = Number(query.get("cursor") || 0);
      const page = items.slice(from, from + 2);
      return json(200, { objects: page, ...(from + 2 < items.length ? { cursor: String(from + 2) } : {}) });
    }
    if (path === "/catalog/batch-retrieve") {
      const variations = items.flatMap((item) => item.item_data.variations as Row[]);
      return json(200, { objects: variations.filter((variation) => (body.object_ids as string[]).includes(variation.id)) });
    }
    if (path === "/inventory/counts/batch-retrieve") {
      return json(200, { counts: countsOf(body.catalog_object_ids, body.location_ids) });
    }
    if (path === "/inventory/changes/batch-retrieve") {
      const found = adjustments.filter(
        (adjustment) => (body.catalog_object_ids as string[]).includes(adjustment.catalog_object_id) && (!body.updated_after || adjustment.occurred_at >= body.updated_after),
      );
      return json(200, { changes: found.map((adjustment) => ({ type: "ADJUSTMENT", adjustment })) });
    }
    if (path === "/inventory/changes/batch-create") {
      const text = JSON.stringify(body.changes);
      const known = keys.get(body.idempotency_key);
      if (known) {
        return known.body === text ? json(200, known.answer) : refused(400, "IDEMPOTENCY_KEY_REUSED", "The idempotency key can only be retried with the same request data.", "idempotency_key");
      }
      const variations = new Set(items.flatMap((item) => (item.item_data.variations as Row[]).filter((variation) => !variation.is_deleted).map((variation) => variation.id as string)));
      for (const change of body.changes as Row[]) {
        if (!variations.has(change.adjustment.catalog_object_id)) {
          return refused(404, "NOT_FOUND", `Catalog object with ID '${change.adjustment.catalog_object_id}' not found.`);
        }
      }
      for (const change of body.changes as Row[]) {
        apply({ ...change.adjustment, source: { product: "EXTERNAL_API" } });
      }
      const ids = [...new Set<string>((body.changes as Row[]).map((change) => change.adjustment.catalog_object_id))];
      const answer = { counts: countsOf(ids, [home]) };
      keys.set(body.idempotency_key, { body: text, answer });
      return json(200, answer);
    }
    if (path === "/orders/search") {
      const from: string = body.query?.filter?.date_time_filter?.updated_at?.start_at || "";
      const found = orders
        .filter((order) => order.state === "COMPLETED" && (body.location_ids as string[]).includes(order.location_id) && order.updated_at >= from)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
      const start = Number(body.cursor || 0);
      const page = found.slice(start, start + 2);
      return json(200, { orders: page, ...(start + 2 < found.length ? { cursor: String(start + 2) } : {}) });
    }
    const order = /^\/orders\/([^/]+)$/.exec(path);
    if (order) {
      const found = orders.find((entry) => entry.id === order[1]);
      return found ? json(200, { order: found }) : refused(404, "NOT_FOUND", "Order not found.");
    }
    const payment = /^\/payments\/([^/]+)$/.exec(path);
    if (payment) {
      const found = payments.find((entry) => entry.id === payment[1]);
      return found ? json(200, { payment: found }) : refused(404, "NOT_FOUND", "Payment not found.");
    }
    const refund = /^\/refunds\/([^/]+)$/.exec(path);
    if (refund) {
      const found = refunds.find((entry) => entry.id === refund[1]);
      return found ? json(200, { refund: found }) : refused(404, "NOT_FOUND", "Refund not found.");
    }
    const customer = /^\/customers\/([^/]+)$/.exec(path);
    if (customer) {
      const found = customers.find((entry) => entry.id === customer[1]);
      return found ? json(200, { customer: found }) : refused(404, "NOT_FOUND", "Customer not found.");
    }
    if (path === "/webhooks/subscriptions" && method === "GET") {
      // The list leaves the signature key out, as Square's does
      return json(200, { subscriptions: subscriptions.map(({ signature_key, ...rest }) => rest) });
    }
    if (path === "/webhooks/subscriptions" && method === "POST") {
      sequence += 1;
      const created = { id: `wbhk_${sequence}`, signature_key: `key-${sequence}`, ...body.subscription };
      subscriptions.push(created);
      return json(200, { subscription: created });
    }
    const subscription = /^\/webhooks\/subscriptions\/([^/]+)$/.exec(path);
    if (subscription) {
      const found = subscriptions.find((entry) => entry.id === subscription[1]);
      if (!found) {
        return refused(404, "NOT_FOUND", "Subscription not found.");
      }
      if (method === "PUT") {
        Object.assign(found, body.subscription);
      }
      return json(200, { subscription: found });
    }
    return refused(404, "NOT_FOUND", `The test Square has no ${method} ${path}`);
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const call: SquareCall = {
        method: init?.method || "GET",
        path: url.pathname.replace(/^\/v2/, ""),
        query: url.searchParams,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== `Bearer ${token}`) {
        return refused(401, "UNAUTHORIZED", "This request could not be authorized.");
      }
      return intercept?.(call) || handle(call);
    }),
  );

  return {
    token,
    items,
    orders,
    payments,
    customers,
    refunds,
    subscriptions,
    adjustments,
    calls,
    /** A catalog item with one variation per SKU, tracked and counted unless said otherwise */
    addItem(name: string, variations: { id: string; sku?: string; name?: string; count?: number; tracked?: boolean; unit?: boolean }[]): Row {
      const item: Row = {
        type: "ITEM",
        id: `ITEM-${name}`,
        present_at_all_locations: true,
        item_data: {
          name,
          variations: variations.map((variation) => ({
            type: "ITEM_VARIATION",
            id: variation.id,
            present_at_all_locations: true,
            item_variation_data: {
              name: variation.name || "Regular",
              sku: variation.sku,
              track_inventory: variation.tracked !== false,
              ...(variation.unit ? { measurement_unit_id: "UNIT1" } : {}),
            },
          })),
        },
      };
      items.push(item);
      for (const variation of variations) {
        if (variation.count !== undefined) {
          counts.set(countKey(variation.id), variation.count);
        }
      }
      return item;
    },
    count(variationId: string): number | undefined {
      return counts.get(countKey(variationId));
    },
    /** What happens in the shop: a sale at the till, a delivery, a recount. Square dates it now */
    change(variationId: string, fromState: string, toState: string, quantity: number, extra: Row = {}): void {
      apply({ catalog_object_id: variationId, from_state: fromState, to_state: toState, from_location_id: home, to_location_id: home, quantity: String(quantity), occurred_at: new Date().toISOString(), ...extra });
    },
    sell(variationId: string, quantity: number): void {
      this.change(variationId, "IN_STOCK", "SOLD", quantity, { transaction_id: "order" });
    },
    /** Sets a count without an adjustment that explains it, as a late offline sale does */
    setCount(variationId: string, quantity: number): void {
      counts.set(countKey(variationId), quantity);
    },
    intercept(handler: ((call: SquareCall) => Response | undefined) | undefined): void {
      intercept = handler;
    },
    requests(path: string): SquareCall[] {
      return calls.filter((call) => call.path === path);
    },
    unavailable(): Response {
      return json(503, { errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE", detail: "Service unavailable." }] });
    },
    refuse: refused,
  };
}

export type TestSquare = ReturnType<typeof createSquare>;
