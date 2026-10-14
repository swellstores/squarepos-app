/**
 * What the app remembers between runs: one record per kind in its `state` collection.
 */

import { isDuplicate, writeErrors } from "./settings";
import type { Page, StoreClient } from "./settings";

export type StateKey =
  /** The claim of the sync that is running */
  | "run"
  /** The webhook subscription registered with Square, and its signature key */
  | "webhook"
  /** How far the search for Square's orders has come */
  | "sales"
  /** The result of the last product match */
  | "match"
  /** What the store's own settings say, which a workflow cannot read: kept current by the functions */
  | "store"
  /** A full comparison that the sweep could not start, since a run was working */
  | "sweep";

export type StateRecord = Record<string, any> & { id: string; key: StateKey };

export async function readState(swell: StoreClient, key: StateKey): Promise<StateRecord | undefined> {
  const found = (await swell.get("/state", { where: { key }, limit: 1 })) as Page<StateRecord>;
  return found?.results?.[0];
}

/** Creates the record or changes it. Two writers at once end with one record */
export async function writeState(swell: StoreClient, key: StateKey, values: Record<string, unknown>): Promise<StateRecord> {
  const existing = await readState(swell, key);
  if (existing) {
    return (await swell.put(`/state/${existing.id}`, values)) as StateRecord;
  }
  let created: unknown;
  try {
    created = await swell.post("/state", { key, ...values });
  } catch (err) {
    if (!isDuplicate(undefined, err)) {
      throw err;
    }
  }
  if (created && !writeErrors(created)) {
    return created as StateRecord;
  }
  const other = await readState(swell, key);
  if (!other) {
    throw new Error(`Unable to save the app's state (${key}): ${writeErrors(created) || "no record"}`);
  }
  return (await swell.put(`/state/${other.id}`, values)) as StateRecord;
}
