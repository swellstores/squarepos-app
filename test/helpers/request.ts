import type { RunRequest, Steps } from "../../functions/lib/run";
import type { TestStore } from "./store";

type Row = Record<string, any>;

/** Work a function handed to `waitUntil`, to be awaited by a test */
export const afterResponse: Promise<unknown>[] = [];

/** A function's request, as far as the app's functions read it */
export function createRequest(store: TestStore, options: { data?: Row; body?: Row; rawBody?: string; headers?: Record<string, string> } = {}): SwellRequest {
  const body = options.body || {};
  return {
    context: { waitUntil: (promise: Promise<unknown>) => afterResponse.push(promise) },
    appId: "squarepos",
    storeId: "alder",
    publicKey: "pk_test_abc",
    store: { id: "alder", url: "https://alder.swell.store", admin_url: "https://alder.swell.store/admin" },
    swell: store.swell,
    data: options.data || body,
    body,
    rawBody: options.rawBody ?? JSON.stringify(body),
    headers: new Headers(options.headers || {}),
  } as unknown as SwellRequest;
}

/** Steps that run at once and remember their names, as a workflow run would have them */
export function createSteps() {
  const names: string[] = [];
  const steps: Steps = {
    async do(name, _options, work) {
      if (names.includes(name)) {
        throw new Error(`Step "${name}" is used twice in one run`);
      }
      names.push(name);
      // A step's result is kept as JSON
      return JSON.parse(JSON.stringify(await work()));
    },
    async sleep(name) {
      names.push(name);
    },
  };
  return { steps, names };
}

export function runRequest(store: TestStore, data: Row = {}, trigger: "function" | "action" = "function", instance = "run-1"): RunRequest {
  return { appId: "squarepos", swell: store.swell, data, workflow: { workflow_instance_id: instance, trigger } };
}
