import { run } from "./lib/run";
import type { Steps } from "./lib/run";

export const config: SwellConfig = {
  kind: "workflow",
  description: "Syncs the stock of linked items between Square and Swell, imports Square sales as orders, and runs the app's dashboard actions",
  action: true,
};

export default class Sync {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    return run(req, step as unknown as Steps);
  }
}
