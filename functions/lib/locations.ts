/**
 * The merchant names locations in the settings; Square and Swell know them by id.
 * These functions find the one for the other, and say what is wrong when they cannot.
 */

import type { Settings } from "./settings";
import type { Location, Merchant } from "./square";

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

export interface Resolved {
  /** The Square location that shares its stock with the store */
  stock?: Location;
  /** The Square locations whose sales are imported */
  sales: Location[];
  /** The stock setting names a location that Square does not have */
  stockProblem?: string;
  /** The same for the sales setting */
  salesProblems: string[];
}

function find(locations: Location[], name: string): Location | undefined {
  return locations.find((location) => same(location.name, name)) || locations.find((location) => location.id === name.trim());
}

export function activeLocations(locations: Location[]): Location[] {
  return locations.filter((location) => !location.status || location.status === "ACTIVE");
}

export function resolveLocations(settings: Settings, merchant: Merchant, locations: Location[]): Resolved {
  const active = activeLocations(locations);
  const names = active.map((location) => `"${location.name || location.id}"`).join(", ");
  const salesProblems: string[] = [];
  let stockProblem: string | undefined;

  let stock: Location | undefined;
  const stockName = (settings.inventory?.location || "").trim();
  if (stockName) {
    stock = find(active, stockName);
    if (!stock) {
      stockProblem = `Square has no active location named "${stockName}" (set under Stock). Its locations: ${names}.`;
    }
  } else {
    stock = active.length === 1 ? active[0] : active.find((location) => location.id === merchant.main_location_id) || active[0];
  }

  const sales: Location[] = [];
  const salesNames = (settings.sales?.locations || "").split(",").map((name) => name.trim()).filter(Boolean);
  if (salesNames.length === 0) {
    sales.push(...active);
  }
  for (const name of salesNames) {
    const location = find(active, name);
    if (!location) {
      salesProblems.push(`Square has no active location named "${name}" (set under In-store sales). Its locations: ${names}.`);
    } else if (!sales.includes(location)) {
      sales.push(location);
    }
  }
  return { stock, sales, stockProblem, salesProblems };
}

export interface SwellLocation {
  id: string;
  name?: string;
}

/**
 * The Swell stock location the setting names. `id` is undefined for the store's stock as
 * a whole. `shipments` is the store's /settings/shipments record.
 */
export function resolveSwellLocation(
  settings: Settings,
  shipments: { features?: { multi_location?: boolean }; locations?: SwellLocation[] } | null | undefined,
): { id?: string; name?: string; problem?: string } {
  const name = (settings.inventory?.swell_location || "").trim();
  if (!name) {
    return {};
  }
  const locations = (shipments?.features?.multi_location && Array.isArray(shipments.locations) && shipments.locations) || [];
  if (locations.length === 0) {
    return { problem: `This store does not keep stock by location: clear "Swell stock location" under Stock.` };
  }
  const found = locations.find((location) => same(location.name, name)) || locations.find((location) => location.id === name);
  if (!found) {
    return {
      problem: `The store has no stock location named "${name}" (set under Stock). Its locations: ${locations.map((location) => `"${location.name || location.id}"`).join(", ")}.`,
    };
  }
  return { id: found.id, name: found.name || found.id };
}
