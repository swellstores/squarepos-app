/**
 * One sync at a time. Two runs working on the same pair at the same moment would each pass
 * the same difference on, so a run first takes the claim: a record that exists once
 * (its key is unique, and of two simultaneous creates the store lets one through).
 *
 * The holder renews the claim while it works and checks before every batch that it still
 * holds it. A claim that was not renewed for a while belongs to a run that died, and is
 * taken over.
 */

import { isDuplicate, writeErrors } from "./settings";
import type { StoreClient } from "./settings";
import { readState } from "./state";

/**
 * A step never works longer than this after it checked the claim (see BATCH_MS in run.ts).
 * A claim that a function took for a run that never began is taken over after it as well
 */
export const STALE_MS = 4 * 60 * 1000;

async function create(swell: StoreClient, owner: string): Promise<boolean> {
  try {
    const created = await swell.post("/state", { key: "run", owner, date_heartbeat: new Date().toISOString() });
    return Boolean(created) && !writeErrors(created);
  } catch (err) {
    if (isDuplicate(undefined, err)) {
      return false;
    }
    throw err;
  }
}

/** Takes the claim. False when another run holds it and shows signs of life */
export async function takeClaim(swell: StoreClient, owner: string, now = Date.now()): Promise<boolean> {
  if (await create(swell, owner)) {
    return true;
  }
  const held = await readState(swell, "run");
  if (!held) {
    // Released between the two requests
    return create(swell, owner);
  }
  if (held.owner === owner) {
    return true;
  }
  const heartbeat = new Date(held.date_heartbeat || held.date_created || 0).getTime();
  if (now - heartbeat < STALE_MS) {
    return false;
  }
  // Removing the dead claim by its id and creating a new one lets one of two takers through:
  // the second removal finds nothing, and the second create is refused
  await swell.delete(`/state/${held.id}`);
  return create(swell, owner);
}

/** Renews the claim. False when the run no longer holds it and must stop writing */
export async function holdsClaim(swell: StoreClient, owner: string): Promise<boolean> {
  const held = await readState(swell, "run");
  if (!held || held.owner !== owner) {
    return false;
  }
  await swell.put(`/state/${held.id}`, { date_heartbeat: new Date().toISOString() });
  return true;
}

export async function releaseClaim(swell: StoreClient, owner: string): Promise<void> {
  const held = await readState(swell, "run");
  if (held && held.owner === owner) {
    await swell.delete(`/state/${held.id}`);
  }
}
