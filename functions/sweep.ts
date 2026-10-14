import { raiseAlert } from "./lib/alerts";
import { ensurePaymentMethod, rememberSwellLocation } from "./lib/store";
import { startSync } from "./lib/marks";
import { accessToken, salesEnabled, squareApi, stockEnabled } from "./lib/settings";
import type { Settings } from "./lib/settings";
import { SquareError, retrieveSubscription } from "./lib/square";
import { readState, writeState } from "./lib/state";

export const config: SwellConfig = {
  description: "Every five minutes: compare the stock of every linked item and look for Square sales, whether or not a notice came",
  cron: { schedule: "*/5 * * * *" },
};

/** Once an hour: Square switches a subscription off when its notices keep failing */
async function checkNotices(req: SwellRequest, settings: Settings): Promise<void> {
  if (new Date().getUTCMinutes() >= 5) {
    return;
  }
  const webhook = await readState(req.swell, "webhook");
  try {
    const subscription = webhook?.subscription_id ? await retrieveSubscription(squareApi(settings, Date.now() + 4000), webhook.subscription_id) : undefined;
    if (!subscription || subscription.enabled === false) {
      await raiseAlert(
        req.swell,
        "webhook",
        subscription
          ? "Square has switched off its notices to this store, as it does when they fail for a long time. Changes are still found every five minutes. Press Test connection to switch the notices on again."
          : "Square's notices to this store are not registered. Changes are still found every five minutes. Press Test connection to register them.",
      );
    }
  } catch (err) {
    // The sync itself reports a refused token or an outage
    if (!(err instanceof SquareError)) {
      throw err;
    }
  }
}

export default async function (req: SwellRequest) {
  const settings = ((await req.swell.settings()) || {}) as Settings;
  if (!accessToken(settings) || (!stockEnabled(settings) && !salesEnabled(settings))) {
    return { skipped: "Nothing is switched on" };
  }
  if (stockEnabled(settings)) {
    await rememberSwellLocation(req.swell, settings);
  }
  if (salesEnabled(settings)) {
    // Removed by hand? Without it, no imported sale can be recorded as paid
    await ensurePaymentMethod(req.swell);
  }
  await checkNotices(req, settings);
  const started = await startSync(req.swell, "sweep", { full: true }, (promise) => req.context.waitUntil(promise));
  if (!started) {
    // A run is working, or waiting to begin: it compares everything before it ends
    await writeState(req.swell, "sweep", { requested: true });
  }
  return { started: started || null };
}
