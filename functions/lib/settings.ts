import type { Api } from "./square";

/** The app's settings as the merchant saved them. Groups are the file names in settings/ */
export interface Settings {
  /** The app's record id in this store */
  id?: string;
  connection?: {
    access_token?: string | null;
    /** "sandbox" calls Square's sandbox. Anything else, a missing value included, the real account */
    environment?: "production" | "sandbox" | null;
    /** The Square account the token belongs to, saved by Test connection */
    account?: string | null;
  };
  inventory?: {
    enabled?: boolean | null;
    /** Name of the Square location that shares its stock with the store. Empty: the account's main location */
    location?: string | null;
    /** Name of the Swell stock location, in stores that keep stock by location. Empty: the store's stock as a whole */
    swell_location?: string | null;
  };
  sales?: {
    enabled?: boolean | null;
    /** Names of the Square locations whose sales are imported, separated by commas. Empty: all of them */
    locations?: string | null;
    /** Lets other apps and webhooks react to imported orders */
    announce?: boolean | null;
  };
}

/** The part of the store client that functions and workflows share */
export interface StoreClient {
  settings(): Promise<unknown>;
  get(path: string, data?: any): Promise<unknown>;
  post(path: string, data?: any): Promise<unknown>;
  put(path: string, data?: any): Promise<unknown>;
  delete(path: string, data?: any): Promise<unknown>;
}

export interface Page<T = Record<string, any>> {
  count?: number;
  results?: T[];
}

export function accessToken(settings: Settings): string {
  return (settings.connection?.access_token || "").trim();
}

export function squareApi(settings: Settings, abortAt?: number): Api {
  return {
    token: accessToken(settings),
    sandbox: settings.connection?.environment === "sandbox",
    abortAt,
  };
}

export function stockEnabled(settings: Settings): boolean {
  return settings.inventory?.enabled === true;
}

export function salesEnabled(settings: Settings): boolean {
  return settings.sales?.enabled === true;
}

/** A write that a workflow's store client refused resolves with `errors` instead of throwing */
export function writeErrors(result: unknown): string | undefined {
  const errors = (result as { errors?: Record<string, { code?: string; message?: string }> } | null)?.errors;
  if (!errors || typeof errors !== "object") {
    return undefined;
  }
  return Object.entries(errors)
    .map(([field, error]) => `${field}: ${error?.message || error?.code || "invalid"}`)
    .join("; ");
}

/** True when a create was refused because a record with the same unique value exists */
export function isDuplicate(result: unknown, thrown?: unknown): boolean {
  const errors =
    (result as { errors?: Record<string, { code?: string }> } | null)?.errors ||
    ((thrown as { body?: Record<string, { code?: string }> } | undefined)?.body as Record<string, { code?: string }> | undefined);
  return Boolean(errors && typeof errors === "object" && Object.values(errors).some((error) => error?.code === "UNIQUE"));
}
