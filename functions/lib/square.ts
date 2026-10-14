/**
 * The Square API, as far as the app uses it. Every call is one request with the merchant's
 * own access token. Nothing here knows about the store.
 */

export const SQUARE_VERSION = "2026-09-16";

export interface Api {
  token: string;
  sandbox: boolean;
  /** Time (ms) after which no new request is started: the caller's own time limit */
  abortAt?: number;
}

export type ErrorKind =
  /** The token is refused: nothing works until the merchant corrects it */
  | "credentials"
  /** Square understood the request and said no. Repeating it changes nothing */
  | "refused"
  /** Too many requests, an outage, a lost connection: worth repeating later */
  | "unavailable";

export class SquareError extends Error {
  kind: ErrorKind;
  status: number;
  code?: string;

  constructor(kind: ErrorKind, message: string, status = 0, code?: string) {
    super(message);
    this.name = "SquareError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export interface Money {
  amount?: number;
  currency?: string;
}

function baseUrl(api: Api): string {
  return api.sandbox ? "https://connect.squareupsandbox.com/v2" : "https://connect.squareup.com/v2";
}

function describe(errors: { category?: string; code?: string; detail?: string; field?: string }[] | undefined, status: number): string {
  const first = errors?.[0];
  if (!first) {
    return `Square answered with status ${status}.`;
  }
  const detail = (first.detail || first.code || "").replace(/\.$/, "");
  return `Square: ${detail}${first.field ? ` (${first.field})` : ""}.`;
}

export async function call<T = Record<string, any>>(api: Api, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  if (!api.token) {
    throw new SquareError("credentials", "No Square access token is saved.");
  }
  const timeLeft = api.abortAt ? api.abortAt - Date.now() : 20000;
  if (timeLeft <= 0) {
    throw new SquareError("unavailable", "Out of time before Square could be asked.");
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl(api)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${api.token}`,
        "Square-Version": SQUARE_VERSION,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeLeft, 20000)),
    });
    text = await response.text();
  } catch (err) {
    throw new SquareError("unavailable", `Square could not be reached (${(err as Error).name || "network error"}).`);
  }

  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // An answer that is not JSON comes from something in front of the API
    if (response.ok) {
      throw new SquareError("unavailable", "Square sent an answer that could not be read.", response.status);
    }
  }
  if (response.ok && !(Array.isArray(data.errors) && data.errors.length > 0)) {
    return data as T;
  }

  const code: string | undefined = data.errors?.[0]?.code;
  const message = describe(data.errors, response.status);
  if (response.status === 401 || code === "UNAUTHORIZED" || code === "ACCESS_TOKEN_EXPIRED" || code === "ACCESS_TOKEN_REVOKED") {
    throw new SquareError("credentials", message, response.status, code);
  }
  if (response.status === 429 || response.status >= 500 || response.status === 408) {
    throw new SquareError("unavailable", message, response.status, code);
  }
  throw new SquareError("refused", message, response.status, code);
}

/* Account */

export interface Merchant {
  id: string;
  business_name?: string;
  country?: string;
  currency?: string;
  main_location_id?: string;
}

export interface Location {
  id: string;
  name?: string;
  status?: string;
  currency?: string;
  timezone?: string;
}

export async function getMerchant(api: Api): Promise<Merchant> {
  const data = await call(api, "GET", "/merchants/me");
  return data.merchant || {};
}

export async function listLocations(api: Api): Promise<Location[]> {
  const data = await call(api, "GET", "/locations");
  return data.locations || [];
}

/* Catalog */

export interface Variation {
  id: string;
  item_id?: string;
  item_name: string;
  name: string;
  sku: string;
  /** Square counts stock for the variation at the location */
  tracked: boolean;
  /** The variation is sold at the location */
  present: boolean;
  /** Sold by weight, length or another measure: quantities are not whole numbers */
  measured: boolean;
}

function presentAt(object: Record<string, any>, locationId: string): boolean {
  if (object.present_at_all_locations === false) {
    return (object.present_at_location_ids || []).includes(locationId);
  }
  return !(object.absent_at_location_ids || []).includes(locationId);
}

export function readVariations(item: Record<string, any>, locationId: string): Variation[] {
  const data = item.item_data || {};
  return (data.variations || [])
    .filter((variation: Record<string, any>) => !variation.is_deleted)
    .map((variation: Record<string, any>) => {
      const details = variation.item_variation_data || {};
      const override = (details.location_overrides || []).find((entry: Record<string, any>) => entry.location_id === locationId);
      return {
        id: variation.id,
        item_id: item.id,
        item_name: (data.name || "").trim(),
        name: (details.name || "").trim(),
        sku: (details.sku || "").trim(),
        // A variation that is not stockable is counted through another one (a case of a bottle, for example)
        tracked: (override?.track_inventory ?? details.track_inventory) === true && details.stockable !== false,
        present: presentAt(item, locationId) && presentAt(variation, locationId),
        measured: Boolean(details.measurement_unit_id),
      };
    });
}

/** One page of the catalog's items, each with its variations */
export async function listItems(api: Api, cursor?: string): Promise<{ items: Record<string, any>[]; cursor?: string }> {
  const query = `types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const data = await call(api, "GET", `/catalog/list?${query}`);
  return { items: (data.objects || []).filter((object: Record<string, any>) => !object.is_deleted), cursor: data.cursor || undefined };
}

/* Inventory */

export interface Count {
  catalog_object_id: string;
  location_id?: string;
  state?: string;
  quantity?: string;
  calculated_at?: string;
}

/**
 * The quantity for sale of each variation at the location, as Square's decimal text.
 * A variation that Square has never counted is not in the answer: missing is not zero.
 */
export async function retrieveCounts(api: Api, variationIds: string[], locationId: string): Promise<Map<string, string>> {
  const counts = new Map<string, string>();
  for (let from = 0; from < variationIds.length; from += 1000) {
    let cursor: string | undefined;
    do {
      const data = await call(api, "POST", "/inventory/counts/batch-retrieve", {
        catalog_object_ids: variationIds.slice(from, from + 1000),
        location_ids: [locationId],
        states: ["IN_STOCK"],
        ...(cursor ? { cursor } : {}),
      });
      for (const count of (data.counts || []) as Count[]) {
        if (count.state === "IN_STOCK" && count.location_id === locationId && typeof count.quantity === "string") {
          counts.set(count.catalog_object_id, count.quantity);
        }
      }
      cursor = data.cursor || undefined;
    } while (cursor);
  }
  return counts;
}

export interface Adjustment {
  id?: string;
  reference_id?: string;
  from_state?: string;
  to_state?: string;
  from_location_id?: string;
  to_location_id?: string;
  catalog_object_id?: string;
  quantity?: string;
  occurred_at?: string;
  created_at?: string;
  source?: { product?: string; application_id?: string; name?: string };
  transaction_id?: string;
  refund_id?: string;
  physical_count_id?: string;
}

/**
 * The adjustments Square recorded for the variations at the location since a time.
 * `complete` is false when there were more than the pages asked for.
 */
export async function retrieveAdjustments(
  api: Api,
  variationIds: string[],
  locationId: string,
  since: string,
  maxPages: number,
): Promise<{ adjustments: Adjustment[]; complete: boolean }> {
  const adjustments: Adjustment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const data = await call(api, "POST", "/inventory/changes/batch-retrieve", {
      catalog_object_ids: variationIds,
      location_ids: [locationId],
      types: ["ADJUSTMENT"],
      updated_after: since,
      ...(cursor ? { cursor } : {}),
    });
    for (const change of data.changes || []) {
      if (change.adjustment) {
        adjustments.push(change.adjustment);
      }
    }
    cursor = data.cursor || undefined;
    pages += 1;
  } while (cursor && pages < maxPages);
  return { adjustments, complete: !cursor };
}

export interface AdjustmentInput {
  reference_id: string;
  catalog_object_id: string;
  from_state: string;
  to_state: string;
  quantity: number;
}

/**
 * Sends adjustments, all or none. With the same key and the same adjustments Square answers
 * as it did the first time and changes nothing.
 */
export async function changeInventory(
  api: Api,
  idempotencyKey: string,
  locationId: string,
  adjustments: AdjustmentInput[],
  occurredAt: string,
): Promise<Count[]> {
  const data = await call(api, "POST", "/inventory/changes/batch-create", {
    idempotency_key: idempotencyKey,
    changes: adjustments.map((adjustment) => ({
      type: "ADJUSTMENT",
      adjustment: {
        reference_id: adjustment.reference_id,
        catalog_object_id: adjustment.catalog_object_id,
        from_state: adjustment.from_state,
        to_state: adjustment.to_state,
        from_location_id: locationId,
        to_location_id: locationId,
        quantity: String(adjustment.quantity),
        occurred_at: occurredAt,
      },
    })),
  });
  return data.counts || [];
}

/* Orders */

/** Completed orders of the locations, oldest change first, from a time on */
export async function searchOrders(
  api: Api,
  locationIds: string[],
  updatedFrom: string,
  cursor?: string,
): Promise<{ orders: Record<string, any>[]; cursor?: string }> {
  const data = await call(api, "POST", "/orders/search", {
    location_ids: locationIds,
    limit: 100,
    ...(cursor ? { cursor } : {}),
    query: {
      filter: {
        state_filter: { states: ["COMPLETED"] },
        date_time_filter: { updated_at: { start_at: updatedFrom } },
      },
      sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
    },
  });
  return { orders: data.orders || [], cursor: data.cursor || undefined };
}

export async function retrieveOrder(api: Api, orderId: string): Promise<Record<string, any> | undefined> {
  try {
    const data = await call(api, "GET", `/orders/${encodeURIComponent(orderId)}`);
    return data.order;
  } catch (err) {
    if (err instanceof SquareError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

export async function retrievePayment(api: Api, paymentId: string): Promise<Record<string, any> | undefined> {
  try {
    const data = await call(api, "GET", `/payments/${encodeURIComponent(paymentId)}`);
    return data.payment;
  } catch (err) {
    if (err instanceof SquareError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

export async function retrieveRefund(api: Api, refundId: string): Promise<Record<string, any> | undefined> {
  try {
    const data = await call(api, "GET", `/refunds/${encodeURIComponent(refundId)}`);
    return data.refund;
  } catch (err) {
    if (err instanceof SquareError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

export async function retrieveCustomer(api: Api, customerId: string): Promise<Record<string, any> | undefined> {
  try {
    const data = await call(api, "GET", `/customers/${encodeURIComponent(customerId)}`);
    return data.customer;
  } catch (err) {
    if (err instanceof SquareError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

/* Webhook subscriptions */

export interface Subscription {
  id: string;
  name?: string;
  enabled?: boolean;
  event_types?: string[];
  notification_url?: string;
  api_version?: string;
  signature_key?: string;
}

export async function listSubscriptions(api: Api): Promise<Subscription[]> {
  const found: Subscription[] = [];
  let cursor: string | undefined;
  do {
    const data = await call(api, "GET", `/webhooks/subscriptions?include_disabled=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    found.push(...(data.subscriptions || []));
    cursor = data.cursor || undefined;
  } while (cursor);
  return found;
}

export async function createSubscription(api: Api, idempotencyKey: string, subscription: Omit<Subscription, "id">): Promise<Subscription> {
  const data = await call(api, "POST", "/webhooks/subscriptions", { idempotency_key: idempotencyKey, subscription });
  return data.subscription;
}

export async function updateSubscription(api: Api, id: string, subscription: Partial<Subscription>): Promise<Subscription> {
  const data = await call(api, "PUT", `/webhooks/subscriptions/${encodeURIComponent(id)}`, { subscription });
  return data.subscription;
}

export async function retrieveSubscription(api: Api, id: string): Promise<Subscription | undefined> {
  try {
    const data = await call(api, "GET", `/webhooks/subscriptions/${encodeURIComponent(id)}`);
    return data.subscription;
  } catch (err) {
    if (err instanceof SquareError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}
