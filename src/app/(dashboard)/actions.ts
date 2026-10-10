"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db";
import { markCallbackDone } from "@/domain/calls";
import { setBookingStatus } from "@/domain/booking";
import { reviewLead, ReviewError, type ReviewAction } from "@/domain/review";
import { completeTask } from "@/domain/tasks";
import { audit } from "@/domain/audit";
import { ensureHandlers } from "@/domain/notifications";
import type { Outcome } from "@/domain/qualification/schema";

const back = (formData: FormData, fallback: string) => String(formData.get("back") ?? fallback);

export async function reviewAction(formData: FormData) {
  const user = await requireUser();
  ensureHandlers();
  const leadId = String(formData.get("leadId"));
  const target = back(formData, `/leads/${leadId}`);
  try {
    await reviewLead({
      leadId, actor: user.email, action: String(formData.get("action")) as ReviewAction,
      reason: String(formData.get("reason") ?? ""), to: (formData.get("to") as Outcome | null) ?? undefined,
    });
  } catch (e) {
    if (e instanceof ReviewError) redirect(`${target}${target.includes("?") ? "&" : "?"}error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath("/", "layout");
  redirect(target.split("?")[0] + "?saved=1");
}

export async function completeTaskAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("taskId"));
  const task = await getDb().get("followup_tasks", id);
  if (!task) return;
  await completeTask(id);
  if (task.kind === "callback" && task.call_id) await markCallbackDone(task.call_id); // a callback defines response time for missed calls
  await audit({ actor: user.email, actorType: "user", action: "task.completed", entityType: "task", entityId: id, after: { kind: task.kind } });
  revalidatePath("/", "layout");
}

export async function bookingStatusAction(formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 5) redirect("/bookings?error=" + encodeURIComponent("A reason is required."));
  await setBookingStatus(String(formData.get("bookingId")), String(formData.get("status")) as "cancelled" | "rescheduled", user.email, reason);
  revalidatePath("/", "layout");
  redirect("/bookings?saved=1");
}
