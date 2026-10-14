import { clearAlert } from "./lib/alerts";
import { isRecordId } from "./lib/ids";
import type { Page } from "./lib/settings";

export const config: SwellConfig = {
  description: "Marks a Square sale that was not imported as dealt with by hand",
  action: true,
};

export default async function (req: SwellRequest) {
  const id = req.data.$action?.record_id;
  if (!isRecordId(id)) {
    throw new SwellError("Unknown sale", { status: 400 });
  }
  const sale = (await req.swell.get(`/sales/${id}`)) as Record<string, any> | null;
  if (!sale) {
    throw new SwellError("Unknown sale", { status: 404 });
  }
  if (sale.status !== "failed" && sale.status !== "skipped") {
    // A waiting sale may be imported at this moment: resolving it could leave a second order
    throw new SwellError(sale.status === "pending" ? "This sale is being imported. Try again in a minute if it still needs attention." : "This sale needs no resolving.", { status: 409 });
  }
  await req.swell.put(`/sales/${id}`, { status: "resolved", problem: null });

  const failed = (await req.swell.get("/sales", { where: { status: "failed" }, limit: 1 })) as Page;
  if ((failed?.count || 0) === 0) {
    await clearAlert(req.swell, "sales");
  }
  return { message: "Marked as resolved. The app will not import this sale." };
}
