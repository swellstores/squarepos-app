/**
 * A sync run: the one place where stock is written and sales are imported. It is started
 * by Square's notices, by stock changes in Swell, by the sweep every five minutes, and by
 * the buttons in the dashboard, and only one run works at a time (see claim.ts).
 *
 * The work is cut into steps. A step that fails is repeated by the platform; a finished
 * step is not run again. Nothing secret is returned from a step, since results are kept.
 */

import { clearAlert, raiseAlert } from "./alerts";
import { holdsClaim, releaseClaim, takeClaim } from "./claim";
import { isRecordId } from "./ids";
import { resolveLocations } from "./locations";
import { dropMissing, matchItems } from "./match";
import { findSales, importSales } from "./sales";
import type { Sale, SalesContext } from "./sales";
import { accessToken, salesEnabled, squareApi, stockEnabled } from "./settings";
import type { Page, Settings, StoreClient } from "./settings";
import { SquareError, getMerchant, listItems, listLocations } from "./square";
import type { Api } from "./square";
import { readState, writeState } from "./state";
import type { StateRecord } from "./state";
import { syncLinks } from "./stock";
import type { Link, StockContext } from "./stock";

type Row = Record<string, any>;

export interface Steps {
  do<T>(name: string, options: Row, work: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

export interface RunRequest {
  appId: string;
  swell: StoreClient;
  data: unknown;
  workflow: { workflow_instance_id: string; trigger: "function" | "action" };
}

type Job =
  /** Marked pairs, and the sales search when one was asked for */
  | "sync"
  /** Every linked pair and the sales search */
  | "full"
  | "match"
  | "start"
  | "stop"
  | "import-past"
  | "retry-sales";

const JOBS: Record<string, Job> = {
  "sync-now": "full",
  match: "match",
  start: "start",
  "start-selected": "start",
  stop: "stop",
  "stop-selected": "stop",
  "import-past": "import-past",
  "retry-sales": "retry-sales",
  retry: "retry-sales",
  "retry-selected": "retry-sales",
};

/** A step works at most this long before it hands the rest to the next one */
const BATCH_MS = 40 * 1000;
const STEP = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };
const MARKED_BATCH = 40;
const FULL_BATCH = 100;
const SALES_BATCH = 10;
const SEARCH_OVERLAP_MS = 2 * 60 * 1000;
/**
 * Steps a search, and the import of the sales it found, take in one round. The next round
 * or run goes on with them: the round's stock sync does not wait for a long import
 */
const SEARCH_STEPS = 3;
const IMPORT_STEPS = 3;
/** Square searches the orders of at most ten locations at a time */
const SEARCH_GROUP = 10;

interface Plan {
  /** Why nothing can be done at all */
  stop?: string;
  /** The Square location that shares its stock, and whether the sync is switched on */
  stock?: { locationId: string; swellLocation?: string; on: boolean; setting: string };
  sales?: { locations: { id: string; name: string }[]; on: boolean };
}

/**
 * Square is asked nothing after this long in a step. A step that outlives its timeout is
 * started again while the first attempt may still be sending
 */
const SQUARE_MS = 80 * 1000;

async function load(swell: StoreClient): Promise<{ settings: Settings; api: Api }> {
  const settings = ((await swell.settings()) || {}) as Settings;
  return { settings, api: squareApi(settings, Date.now() + SQUARE_MS) };
}

/** Run inside a step: a refused token is the merchant's to correct, and no reason to repeat the step */
async function guarded(swell: StoreClient, work: () => Promise<Row>): Promise<Row> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof SquareError && err.kind === "credentials") {
      await raiseAlert(swell, "connection", `Square did not accept the access token. ${err.message} Paste a valid token under Connection and press Test connection.`);
      return { refused: err.message };
    }
    throw err;
  }
}

function refused(result: Row): boolean {
  return typeof result.refused === "string";
}

/** What the settings ask for and what Square has for it */
async function prepare(swell: StoreClient): Promise<Plan> {
  const { settings, api } = await load(swell);
  if (!accessToken(settings)) {
    return { stop: "No Square access token is saved." };
  }
  const [merchant, locations] = await Promise.all([getMerchant(api), listLocations(api)]);
  const resolved = resolveLocations(settings, merchant, locations);
  const plan: Plan = {};
  const problems: string[] = [];

  if (resolved.stockProblem) {
    if (stockEnabled(settings)) {
      problems.push(resolved.stockProblem);
    }
  } else if (resolved.stock) {
    plan.stock = { locationId: resolved.stock.id, on: stockEnabled(settings), setting: stockSetting(settings) };
    const name = (settings.inventory?.swell_location || "").trim();
    if (name) {
      // A workflow cannot read the store's own settings: the functions keep what they say
      const store = await readState(swell, "store");
      if (store?.swell_location === name && store.swell_location_id) {
        plan.stock.swellLocation = store.swell_location_id;
      } else {
        plan.stock = undefined;
        if (stockEnabled(settings)) {
          problems.push((store?.swell_location === name && store.problem) || `The Swell stock location "${name}" has not been checked yet. Press Test connection.`);
        }
      }
    }
  }
  if (resolved.salesProblems.length > 0) {
    if (salesEnabled(settings)) {
      problems.push(...resolved.salesProblems);
    }
  } else if (resolved.sales.length > 0) {
    plan.sales = { locations: resolved.sales.map((location) => ({ id: location.id, name: location.name || location.id })), on: salesEnabled(settings) };
  }
  if (salesEnabled(settings) && !startTime(settings)) {
    // Computed when the settings are saved: settings last saved before that have none, and a guessed start could leave sales out
    problems.push("The sales import has no start time yet. Open the app's settings and save them once.");
  }

  if (problems.length > 0) {
    await raiseAlert(swell, "connection", problems.join(" "));
  } else {
    await clearAlert(swell, "connection");
  }
  return plan;
}

/* The records an action was run on */

/** Calls `work` for the records the merchant chose, in pages. `only` narrows them further */
async function chosen(
  swell: StoreClient,
  collection: "items" | "sales",
  data: Row,
  only: Row,
  after: string | undefined,
  work: (record: Row) => Promise<void>,
): Promise<{ last?: string; count: number }> {
  const action = (data.$action || {}) as Row;
  const conditions: Row[] = [only];
  if (action.source === "record" || action.source === "field") {
    if (!isRecordId(action.record_id)) {
      return { count: 0 };
    }
    conditions.push({ id: action.record_id });
  }
  const query = action.source === "bulk" && action.selection?.query ? (action.selection.query as Row) : {};
  if (after) {
    conditions.push({ id: { $gt: after } });
  }
  const page = (await swell.get(`/${collection}`, {
    ...query,
    $and: [...(query.$and || []), ...conditions],
    sort: "id asc",
    limit: 100,
  })) as Page;
  const records = page?.results || [];
  for (const record of records) {
    await work(record);
  }
  return { last: records.length === 100 ? records[records.length - 1].id : undefined, count: records.length };
}

/* Stock */

/** The stock settings the run's plan was made from: the sync, and the two locations it names */
function stockSetting(settings: Settings): string {
  return JSON.stringify([stockEnabled(settings), (settings.inventory?.location || "").trim(), (settings.inventory?.swell_location || "").trim()]);
}

async function stockBatch(req: RunRequest, owner: string, plan: Plan, query: Row, limit: number): Promise<Row> {
  return guarded(req.swell, async () => {
    if (!(await holdsClaim(req.swell, owner))) {
      return { lost: true };
    }
    const { settings, api } = await load(req.swell);
    if (stockSetting(settings) !== plan.stock!.setting) {
      // Switched off, or another location chosen, since the run began: the next run works with them
      return { changed: true };
    }
    const page = (await req.swell.get("/items", { ...query, sort: "id asc", limit })) as Page<Link>;
    const links = page?.results || [];
    const ctx: StockContext = {
      swell: req.swell,
      api,
      locationId: plan.stock!.locationId,
      swellLocation: plan.stock!.swellLocation,
      deadline: Date.now() + BATCH_MS,
    };
    const outcome = await syncLinks(ctx, links);
    const reached = links.length - outcome.left;
    return { ...outcome, found: links.length, last: reached > 0 ? links[reached - 1].id : undefined };
  });
}

async function syncStock(
  req: RunRequest,
  step: Steps,
  owner: string,
  plan: Plan,
  full: boolean,
  round: number,
): Promise<{ lost?: boolean; refused?: boolean; changed?: boolean; stopped: number }> {
  const location = plan.stock!.locationId;
  let stopped = 0;

  // Items started with another Square location: that location's count is not this one's
  if (full) {
    stopped += (
      await step.do(`other location ${round}`, STEP, async () => {
        if (stockSetting(((await req.swell.settings()) || {}) as Settings) !== plan.stock!.setting) {
          return { stopped: 0 };
        }
        const page = (await req.swell.get("/items", { where: { status: "active", location_id: { $ne: location } }, limit: 100 })) as Page<Link>;
        for (const link of page?.results || []) {
          await req.swell.put(`/items/${link.id}`, {
            status: "error",
            reason: "The Square location set under Inventory has changed since this item was started. Match products again and start the items of the new location.",
            marked: false,
          });
        }
        return { stopped: page?.results?.length || 0 };
      })
    ).stopped;
  }

  // Pairs that a notice marked, that are starting, or whose step was cut short
  for (let batch = 1; batch <= 100; batch += 1) {
    const result = await step.do(`stock ${round}.${batch}`, STEP, () =>
      stockBatch(req, owner, plan, { where: { status: "active", location_id: location, $or: [{ marked: true }, { pending: true }] } }, MARKED_BATCH),
    );
    if (result.lost || refused(result) || result.changed) {
      return { lost: result.lost === true, refused: refused(result), changed: result.changed === true, stopped };
    }
    stopped += result.stopped || 0;
    if (result.found < MARKED_BATCH && !result.left) {
      break;
    }
  }

  // Every linked pair, notice or not: a lost notice costs minutes, not stock
  if (full) {
    let after: string | undefined;
    for (let batch = 1; batch <= 400; batch += 1) {
      const cursor: string | undefined = after;
      const result = await step.do(`compare ${round}.${batch}`, STEP, () =>
        stockBatch(req, owner, plan, { where: { status: "active", location_id: location, ...(cursor ? { id: { $gt: cursor } } : {}) } }, FULL_BATCH),
      );
      if (result.lost || refused(result) || result.changed) {
        return { lost: result.lost === true, refused: refused(result), changed: result.changed === true, stopped };
      }
      stopped += result.stopped || 0;
      if (!result.last || (result.found < FULL_BATCH && !result.left)) {
        break;
      }
      after = result.last;
    }
  }
  return { stopped };
}

/* Sales */

function salesContext(req: RunRequest, plan: Plan, settings: Settings, api: Api): SalesContext {
  return {
    swell: req.swell,
    api,
    appId: req.appId,
    locations: plan.sales!.locations,
    announce: settings.sales?.announce === true,
    deadline: Date.now() + BATCH_MS,
  };
}

/**
 * A search of Square's completed orders changed in a time range. It is kept in the app's
 * state with Square's cursor, so that the search goes on where it stopped, in the next
 * step or in the next run, and never skips an order. `search` is the search for new sales,
 * `past` the one for Import past sales.
 */
interface Pass {
  from: string;
  until: string;
  /** The Square locations searched (ids separated by commas), ten at a time, and the ten being read */
  locations: string;
  group: number;
  /** Square's cursor to the next page of the ten being read */
  page: string | null;
}

type PassKey = "search" | "past";

/** When the sales import was switched on: computed by the settings save that switched it on */
function startTime(settings: Settings): string | undefined {
  const saved = settings.sales?.enabled_at;
  return saved && Number.isFinite(new Date(saved).getTime()) ? new Date(saved).toISOString() : undefined;
}

/** Only the workflow, while holding the claim, initializes or resets search progress. */
async function salesState(swell: StoreClient, settings: Settings): Promise<StateRecord | undefined> {
  if (!salesEnabled(settings)) {
    return undefined;
  }
  const state = await readState(swell, "sales");
  const at = startTime(settings);
  if (!at) {
    // Named by prepare() in the connection alert
    return undefined;
  }
  if (state?.enabled_at === at) {
    return state;
  }
  // Switched on (again): the import starts from that save, and searches under way are dropped
  return writeState(swell, "sales", { enabled_at: at, date_from: at, cursor: at, requested: true, search: null, past: null });
}

function newPass(plan: Plan, from: string, until: string): Pass {
  return { from, until, locations: locationIds(plan), group: 0, page: null };
}

function locationIds(plan: Plan): string {
  return plan
    .sales!.locations.map((location) => location.id)
    .sort()
    .join(",");
}

/**
 * Goes on with a search for some steps. `done` once it has read its range for every location.
 * `failed` counts the sales whose refunds the store refused
 */
async function searchSales(
  req: RunRequest,
  step: Steps,
  owner: string,
  plan: Plan,
  key: PassKey,
  name: string,
): Promise<{ lost?: boolean; refused?: boolean; done?: boolean; failed: number }> {
  let failed = 0;
  for (let batch = 1; batch <= SEARCH_STEPS; batch += 1) {
    const result = await step.do(`${name} ${batch}`, STEP, () =>
      guarded(req.swell, async () => {
        if (!(await holdsClaim(req.swell, owner))) {
          return { lost: true };
        }
        const { settings, api } = await load(req.swell);
        const state = await salesState(req.swell, settings);
        const saved = state?.[key] as Pass | null | undefined;
        if (!saved) {
          return { done: true };
        }
        const ctx = { ...salesContext(req, plan, settings, api), from: state?.date_from };
        // Other locations chosen since the search began: it reads its range again for those
        let pass: Pass = saved.locations === locationIds(plan) ? { ...saved } : { ...saved, locations: locationIds(plan), group: 0, page: null };
        const ids = pass.locations.split(",");
        let refusedRefunds = 0;
        do {
          try {
            const found = await findSales(ctx, ids.slice(pass.group * SEARCH_GROUP, (pass.group + 1) * SEARCH_GROUP), pass.from, pass.until, pass.page || undefined);
            refusedRefunds += found.failed;
            pass = found.cursor ? { ...pass, page: found.cursor } : { ...pass, group: pass.group + 1, page: null };
          } catch (err) {
            if (!(pass.page && err instanceof SquareError && err.kind === "refused")) {
              throw err;
            }
            // A cursor kept from an earlier run that Square no longer takes: these ten are read again
            pass = { ...pass, page: null };
          }
        } while (pass.group * SEARCH_GROUP < ids.length && Date.now() < ctx.deadline);
        const done = pass.group * SEARCH_GROUP >= ids.length;
        await writeState(req.swell, "sales", {
          [key]: done ? null : pass,
          // Read to its end for every location: the next search for new sales starts there
          ...(done && key === "search" && !(state?.cursor && state.cursor >= pass.until) ? { cursor: pass.until } : {}),
        });
        return { done, failed: refusedRefunds };
      }),
    );
    if (result.lost || refused(result)) {
      return { lost: result.lost === true, refused: refused(result), failed };
    }
    failed += result.failed || 0;
    if (result.done) {
      return { done: true, failed };
    }
  }
  return { done: false, failed };
}

/** Imports waiting sales for some steps. `more` when sales are left for the next round */
async function importWaiting(req: RunRequest, step: Steps, owner: string, plan: Plan, round: number): Promise<{ lost?: boolean; refused?: boolean; failed: number; more?: boolean }> {
  let after: string | undefined;
  let failed = 0;
  for (let batch = 1; batch <= IMPORT_STEPS; batch += 1) {
    const cursor: string | undefined = after;
    const result = await step.do(`import ${round}.${batch}`, STEP, () =>
      guarded(req.swell, async () => {
        if (!(await holdsClaim(req.swell, owner))) {
          return { lost: true };
        }
        const { settings, api } = await load(req.swell);
        if (!salesEnabled(settings)) {
          return { found: 0, failed: 0 };
        }
        const page = (await req.swell.get("/sales", {
          where: { status: "pending", ...(cursor ? { id: { $gt: cursor } } : {}) },
          sort: "id asc",
          limit: SALES_BATCH,
        })) as Page<Sale>;
        const sales = page?.results || [];
        const outcome = await importSales(salesContext(req, plan, settings, api), sales);
        const reached = sales.length - outcome.left;
        return { ...outcome, found: sales.length, last: reached > 0 ? sales[reached - 1].id : undefined };
      }),
    );
    if (result.lost || refused(result)) {
      return { lost: result.lost === true, refused: refused(result), failed };
    }
    failed += result.failed || 0;
    if (!result.last || (result.found < SALES_BATCH && !result.left)) {
      return { failed };
    }
    after = result.last;
  }
  return { failed, more: true };
}

/** The alert about sales is over once none is left that needs attention */
async function settleSales(swell: StoreClient, failedNow: number): Promise<void> {
  const failed = (await swell.get("/sales", { where: { status: "failed" }, limit: 1 })) as Page;
  if ((failed?.count || 0) === 0) {
    await clearAlert(swell, "sales");
  } else if (failedNow > 0) {
    const count = failed.count || failedNow;
    await raiseAlert(swell, "sales", `${count} Square ${count === 1 ? "sale" : "sales"} could not be imported. ${failed.results?.[0]?.problem || ""}`.trim());
  }
}

/* The run */

export async function run(req: RunRequest, step: Steps): Promise<Row> {
  const data = ((req.data && typeof req.data === "object" ? req.data : {}) as Row) || {};
  // Only a run started by the dashboard carries an action that can be trusted
  const action = req.workflow.trigger === "action" ? ((data.$action || {}) as Row) : undefined;
  const job: Job = action ? JOBS[action.id as string] || "sync" : data.full === true ? "full" : "sync";
  const swell = req.swell;

  // The function that started the run took the claim for it: the run takes it up first
  const adopted =
    !action && typeof data.claim === "string"
      ? await step.do("claim", STEP, async () => ({ held: await holdsClaim(swell, data.claim) })).then((result) => result.held)
      : false;

  let plan: Plan & { refused?: string };
  try {
    plan = (await step.do("prepare", STEP, () => guarded(swell, () => prepare(swell)))) as Plan & { refused?: string };
  } catch (err) {
    // Square cannot be reached: the next notice or sweep starts a run without waiting for the claim to expire
    if (adopted) {
      await step.do("release", STEP, async () => releaseClaim(swell, data.claim).then(() => ({})));
    }
    throw err;
  }
  if (plan.stop || plan.refused) {
    if (adopted) {
      await step.do("release", STEP, async () => releaseClaim(swell, data.claim).then(() => ({})));
    }
    return { job, stopped: plan.stop || plan.refused };
  }

  if (!action && !plan.stock?.on && !plan.sales?.on) {
    if (adopted) {
      await step.do("release", STEP, async () => releaseClaim(swell, data.claim).then(() => ({})));
    }
    return { job, stopped: "Neither the stock sync nor the sales import is switched on." };
  }

  /* What needs no claim: the app's own records, and no stock or order is touched */

  if (job === "stop") {
    let after: string | undefined;
    let count = 0;
    for (let batch = 1; batch <= 500; batch += 1) {
      const cursor: string | undefined = after;
      const page = await step.do(`stop ${batch}`, STEP, () =>
        chosen(swell, "items", data, { status: { $in: ["active", "error"] } }, cursor, async (link) => {
          await swell.put(`/items/${link.id}`, {
            status: link.product_id ? "ready" : "unlinked",
            agreed: null,
            start: null,
            step: null,
            pending: false,
            marked: false,
            oversold: false,
            reason: null,
          });
        }),
      );
      count += page.count;
      if (!page.last) {
        break;
      }
      after = page.last;
    }
    return { job, stopped_links: count };
  }

  if (job === "match") {
    if (!plan.stock) {
      return { job, stopped: "No Square location to match products for." };
    }
    const context = async () => {
      const { api } = await load(swell);
      return { swell, api, locationId: plan.stock!.locationId, swellLocation: plan.stock!.swellLocation };
    };
    // Records of variations that are gone first: they would count as a second holder of their SKU
    let after: string | undefined;
    for (let batch = 1; batch <= 200; batch += 1) {
      const cursor: string | undefined = after;
      const last = await step.do(`match cleanup ${batch}`, STEP, async () => {
        const page = (await swell.get("/items", {
          where: { location_id: plan.stock!.locationId, ...(cursor ? { id: { $gt: cursor } } : {}) },
          sort: "id asc",
          limit: 200,
        })) as Page;
        const links = page?.results || [];
        await dropMissing(await context(), links);
        return { last: links.length === 200 ? (links[links.length - 1].id as string) : null };
      });
      if (!last.last) {
        break;
      }
      after = last.last;
    }
    let cursor: string | undefined;
    const totals = { matched: 0, unlinked: 0, without_sku: 0 };
    for (let batch = 1; batch <= 500; batch += 1) {
      const from: string | undefined = cursor;
      const page = await step.do(`match ${batch}`, STEP, async () => {
        const ctx = await context();
        const items = await listItems(ctx.api, from);
        const outcome = await matchItems(ctx, items.items);
        return { ...outcome, cursor: items.cursor || null };
      });
      totals.matched += page.matched;
      totals.unlinked += page.unlinked;
      totals.without_sku += page.without_sku;
      if (!page.cursor) {
        break;
      }
      cursor = page.cursor;
    }
    return { job, ...totals };
  }

  if (job === "start") {
    const side = data.side === "swell" ? "swell" : "square";
    let after: string | undefined;
    for (let batch = 1; batch <= 500; batch += 1) {
      const cursor: string | undefined = after;
      const page = await step.do(`start ${batch}`, STEP, () =>
        chosen(swell, "items", data, { status: { $in: ["ready", "error"] } }, cursor, async (link) => {
          // "Agreed" is forgotten: the first sync takes the chosen side's quantity for both
          await swell.put(`/items/${link.id}`, {
            status: "active",
            start: side,
            agreed: null,
            step: null,
            pending: false,
            marked: true,
            oversold: false,
            reason: null,
          });
        }),
      );
      if (!page.last) {
        break;
      }
      after = page.last;
    }
  }

  if (job === "retry-sales") {
    let after: string | undefined;
    for (let batch = 1; batch <= 500; batch += 1) {
      const cursor: string | undefined = after;
      const page = await step.do(`retry ${batch}`, STEP, () =>
        // From the app's page: everything that failed. On a sale or a selection: skipped ones as well
        chosen(swell, "sales", data, { status: { $in: action?.source === "settings" ? ["failed"] : ["failed", "skipped"] } }, cursor, async (sale) => {
          await swell.put(`/sales/${sale.id}`, { status: "pending", attempts: 0 });
        }),
      );
      if (!page.last) {
        break;
      }
      after = page.last;
    }
  }

  /* What needs the claim */

  let owner = req.workflow.workflow_instance_id;
  let held = adopted;
  if (adopted) {
    owner = data.claim as string;
  }
  // A button waits for the run that is working; a notice does not, since that run looks for new marks before it ends
  const attempts = action ? 30 : 1;
  for (let attempt = 1; !held && attempt <= attempts; attempt += 1) {
    held = await step.do(`claim ${attempt}`, STEP, async () => ({ held: await takeClaim(swell, owner) })).then((result) => result.held);
    if (!held && attempt < attempts) {
      await step.sleep(`wait ${attempt}`, "10 seconds");
    }
  }
  if (!held) {
    return { job, stopped: "Another sync is running." };
  }

  const summary: Row = { job };
  try {
    for (let round = 1; round <= 3; round += 1) {
      let failed = 0;
      let importing = false;
      // A sweep that found this run working asked it for a full comparison
      const asked = await step.do(`sweep ${round}`, STEP, async () => {
        const sweep = await readState(swell, "sweep");
        if (sweep?.requested !== true) {
          return { full: false };
        }
        await writeState(swell, "sweep", { requested: false });
        return { full: true };
      });
      const full = (round === 1 && job === "full") || asked.full;

      if (plan.stock?.on) {
        const stock = await syncStock(req, step, owner, plan, full, round);
        if (stock.lost || stock.refused) {
          summary.stopped = stock.lost ? "Another run took over." : "Square did not accept the access token.";
          break;
        }
        await step.do(`stock alert ${round}`, STEP, async () => {
          if (stock.stopped > 0) {
            await raiseAlert(swell, "stock", `${stock.stopped} linked ${stock.stopped === 1 ? "item has" : "items have"} stopped syncing. They are listed with the reason under Products → Square stock → Needs attention.`);
          } else if (((await swell.get("/items", { where: { status: "error" }, limit: 1 })) as Page)?.count === 0) {
            // Over once no item needs starting again: an item that stops later is news, with its own e-mail
            await clearAlert(swell, "stock");
          }
          return {};
        });
        if (stock.changed) {
          // The rest of this run leaves the stock alone: the next one works with the new settings
          plan.stock.on = false;
          summary.stock = "The stock settings changed while the run worked.";
        }
      }

      if (plan.sales?.on) {
        const since = round === 1 && job === "import-past" && typeof data.since === "string" && !Number.isNaN(new Date(data.since).getTime()) ? new Date(data.since).toISOString() : undefined;
        const todo = await step.do(`sales ${round}`, STEP, async () => {
          if (!(await holdsClaim(swell, owner))) {
            return { lost: true, on: false, search: false, past: false };
          }
          const settings = ((await swell.settings()) || {}) as Settings;
          const state = await salesState(swell, settings);
          if (!state?.enabled_at) {
            // Switched off since the run began, or missing a reliable boundary
            return { on: false, search: false, past: false };
          }
          const now = new Date().toISOString();
          const values: Row = {};
          // A search under way ends where it began: a notice that came since waits for the next one
          if (!state.search && (state.requested === true || full || job === "retry-sales" || job === "import-past")) {
            // Square may list an order a moment after a later one: the search reaches back a little
            values.search = newPass(plan, new Date(new Date(state.cursor || state.enabled_at).getTime() - SEARCH_OVERLAP_MS).toISOString(), now);
            // Taken off before the search: a notice that comes from now on is for the next one
            values.requested = false;
          }
          // A date still to come has no sales yet, and Square takes no range that ends before it begins
          if (since && since < now) {
            // Up to now: the search for new sales goes on from its own cursor. A past search
            // under way from an earlier date is begun again from that date
            const past = state.past as Pass | null | undefined;
            values.past = newPass(plan, past && past.from < since ? past.from : since, now);
            if (!state.date_from || new Date(since) < new Date(state.date_from)) {
              values.date_from = since;
            }
          }
          if (Object.keys(values).length > 0) {
            await writeState(swell, "sales", values);
          }
          return { on: true, search: Boolean(state.search || values.search), past: Boolean(state.past || values.past) };
        });
        if (todo.lost) {
          summary.stopped = "Another run took over.";
          break;
        }
        if (todo.on) {
          if (todo.search) {
            const found = await searchSales(req, step, owner, plan, "search", `sales search ${round}`);
            if (found.lost || found.refused) {
              summary.stopped = "The search for sales was cut short.";
              break;
            }
            failed += found.failed;
          }
          if (todo.past) {
            const past = await searchSales(req, step, owner, plan, "past", `past sales ${round}`);
            if (past.lost || past.refused) {
              summary.stopped = "The search for past sales was cut short.";
              break;
            }
            failed += past.failed;
          }
          const imported = await importWaiting(req, step, owner, plan, round);
          if (imported.lost || imported.refused) {
            summary.stopped = "The import of sales was cut short.";
            break;
          }
          failed += imported.failed;
          importing = imported.more === true;
          await step.do(`sales alert ${round}`, STEP, async () => settleSales(swell, failed).then(() => ({})));
        }
      }

      // Notices that came while the run worked. The claim is given back first: whoever
      // marks from now on sees no run and starts one
      const more = await step.do(`release ${round}`, STEP, async () => {
        await releaseClaim(swell, owner);
        const marked = plan.stock?.on
          ? ((await swell.get("/items", { where: { status: "active", location_id: plan.stock.locationId, marked: true }, limit: 1 })) as Page)
          : undefined;
        const sales = plan.sales?.on ? await readState(swell, "sales") : undefined;
        const sweep = await readState(swell, "sweep");
        // A search not read to its end, or sales not yet imported, go on in the next round
        const searching = Boolean(sales?.requested === true || sales?.search || sales?.past) || importing;
        if ((marked?.count || 0) === 0 && !searching && sweep?.requested !== true) {
          return { again: false };
        }
        return { again: await takeClaim(swell, owner) };
      });
      held = more.again;
      if (!more.again) {
        break;
      }
    }
  } finally {
    if (held) {
      await step.do("release", STEP, async () => releaseClaim(swell, owner).then(() => ({})));
    }
  }
  return summary;
}
