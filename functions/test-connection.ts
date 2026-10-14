import { clearAlert } from "./lib/alerts";
import { requestKey } from "./lib/ids";
import { resolveLocations } from "./lib/locations";
import { ensurePaymentMethod, rememberSwellLocation } from "./lib/store";
import { accessToken, salesEnabled, squareApi, stockEnabled } from "./lib/settings";
import type { Page, Settings } from "./lib/settings";
import { SQUARE_VERSION, SquareError, createSubscription, getMerchant, listLocations, listSubscriptions, retrieveSubscription, updateSubscription } from "./lib/square";
import type { Api, Subscription } from "./lib/square";
import { readState, writeState } from "./lib/state";

export const config: SwellConfig = {
  description: "Check the saved access token with Square, show the account's locations, and register the notices Square sends to this store",
  action: true,
};

/** What Square tells the store about. Payments and refunds announce sales; orders carry no more than they do */
export const EVENT_TYPES = ["inventory.count.updated", "payment.created", "payment.updated", "refund.created", "refund.updated"];

/**
 * The address Square sends its notices to: the app's public route. A route is reached with
 * a public key of the store, which Square's sender carries as the address's credentials.
 */
export function noticeAddress(storeId: string, publicKey: string, appId: string): string {
  return `https://${storeId}:${publicKey}@${storeId}.swell.store/functions/${appId}/square-events`;
}

/** Makes sure Square has one subscription for this store and environment, switched on, and that the app knows its signature key */
export async function registerNotices(req: SwellRequest, api: Api): Promise<void> {
  const publicKey: string = (req as any).publicKey || req.headers.get("swell-public-key") || "";
  const storeId: string = (req as any).storeId || req.store?.id || "";
  if (!publicKey || !storeId) {
    throw new SwellError("The store did not provide the address for Square's notices. Try again in a minute.", { status: 502 });
  }
  const address = noticeAddress(storeId, publicKey, req.appId);
  const wanted = { enabled: true, event_types: EVENT_TYPES, notification_url: address, api_version: SQUARE_VERSION };

  const state = await readState(req.swell, "webhook");
  let subscription: Subscription | undefined = state?.subscription_id ? await retrieveSubscription(api, state.subscription_id) : undefined;
  if (!subscription) {
    // The record may be gone while the subscription is not, after a reinstall for example
    const same = (await listSubscriptions(api)).find((candidate) => candidate.notification_url === address);
    subscription = same ? await retrieveSubscription(api, same.id) : undefined;
  }
  if (subscription) {
    const current =
      subscription.enabled === true &&
      subscription.notification_url === address &&
      subscription.api_version === SQUARE_VERSION &&
      EVENT_TYPES.every((type) => (subscription!.event_types || []).includes(type));
    if (!current) {
      await updateSubscription(api, subscription.id, wanted);
      subscription = (await retrieveSubscription(api, subscription.id)) || subscription;
    }
  } else {
    const test = /_test_/.test(publicKey);
    const created = await createSubscription(api, await requestKey(`${address}@${Date.now()}`), { name: `Swell ${storeId}${test ? " (test)" : ""}`, ...wanted });
    subscription = (await retrieveSubscription(api, created.id)) || created;
  }
  if (!subscription.signature_key) {
    throw new SwellError("Square registered the notices but did not return their signature key. Press Test connection again.", { status: 502 });
  }
  if (state?.subscription_id !== subscription.id || state?.signature_key !== subscription.signature_key || state?.address !== address) {
    await writeState(req.swell, "webhook", { subscription_id: subscription.id, signature_key: subscription.signature_key, address });
  }
}

export default async function (req: SwellRequest) {
  const started = Date.now();
  const settings = ((await req.swell.settings()) || {}) as Settings;
  if (!accessToken(settings)) {
    throw new SwellError("Enter the Square access token, save the settings, then test again.", { status: 400 });
  }
  // The merchant waits for the answer, and a function has ten seconds
  const api = squareApi(settings, started + 8000);
  const sandbox = api.sandbox;

  let message: string;
  try {
    const [merchant, locations] = await Promise.all([getMerchant(api), listLocations(api)]);
    const resolved = resolveLocations(settings, merchant, locations);
    const swellLocation = await rememberSwellLocation(req.swell, settings);
    const problems = [resolved.stockProblem, ...resolved.salesProblems, swellLocation.problem].filter(Boolean);
    if (problems.length > 0) {
      throw new SwellError(problems.join(" "), { status: 400 });
    }
    await registerNotices(req, api);
    await ensurePaymentMethod(req.swell);

    const account = `${merchant.business_name || "Square account"}${sandbox ? " (sandbox)" : ""}`;
    if (settings.connection?.account !== account) {
      try {
        await req.swell.put(`/settings/${req.appId}`, { connection: { account } });
      } catch (err) {
        // Only the display of the account name depends on it
        console.error("Unable to save the Square account name", (err as Error).message);
      }
    }
    await clearAlert(req.swell, "connection");
    await clearAlert(req.swell, "webhook");

    const [ready, failed] = (await Promise.all([
      req.swell.get("/items", { where: { status: "ready" }, limit: 1 }),
      req.swell.get("/sales", { where: { status: "failed" }, limit: 1 }),
    ])) as Page[];
    const parts = [
      `Connected to ${account}.`,
      resolved.stock ? `Stock is shared with the Square location "${resolved.stock.name || resolved.stock.id}".` : "",
      resolved.sales.length > 0 ? `Sales are imported from: ${resolved.sales.map((location) => location.name || location.id).join(", ")}.` : "",
      "Square's notices are registered.",
      stockEnabled(settings) ? "" : "The stock sync is switched off.",
      salesEnabled(settings) ? "" : "The sales import is switched off.",
      (ready?.count || 0) > 0 ? `${ready.count} matched ${ready.count === 1 ? "item waits" : "items wait"} to be started under Products → Square stock.` : "",
      (failed?.count || 0) > 0 ? `${failed.count} ${failed.count === 1 ? "sale needs" : "sales need"} attention under Orders → Square sales.` : "",
      sandbox ? "" : /_test_/.test(String((req as any).publicKey || "")) ? "Note: this is the store's test environment, connected to your real Square account. Stock changes here reach your shop." : "",
    ];
    message = parts.filter(Boolean).join(" ");
  } catch (err) {
    if (err instanceof SquareError && err.kind === "credentials") {
      throw new SwellError(
        `Square did not accept the access token. Copy it again from your application's Credentials page in the Square Developer Console, and check that "Square environment" matches the token (${sandbox ? "Sandbox" : "Production"} is selected).`,
        { status: 400 },
      );
    }
    if (err instanceof SquareError && err.kind === "refused") {
      throw new SwellError(err.message, { status: 400 });
    }
    if (err instanceof SquareError) {
      throw new SwellError(`${err.message} Try again in a minute.`, { status: 502 });
    }
    throw err;
  }
  return { message };
}
