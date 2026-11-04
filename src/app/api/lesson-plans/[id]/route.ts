import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireAnyPermission, requirePermission } from "@/lib/rbac";
import { handleApiError, ok, readJson, clientIp } from "@/lib/api";
import { deletePlan, getPlanForEdit, updatePlan } from "@/lib/lesson-plan-data";

/** Who may edit / delete a formed plan (teaching logins are limited to their own groups in lesson-plan-data.ts). */
const EDIT_PERMISSIONS = ["sessions.update", "lessons.plan"] as const;

const updateSchema = z.object({
  lessonsPerWeek: z.number().int().min(1).max(14),
  lessons: z
    .array(
      z.object({
        date: z.string().date(),
        startMinutes: z.number().int().min(0).max(1439)
      })
    )
    .max(62)
});

/** The plan's lessons plus the month's other real slot dates — everything the edit screen needs. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requirePermission("sessions.view");
    return ok(await getPlanForEdit(ctx, params.id));
  } catch (err) {
    return handleApiError("lesson-plans.get", err);
  }
}

/**
 * Edits a formed plan: add / remove dates and change lessons per week.
 * Lessons with history are always kept; the rest are renumbered 1..n.
 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireAnyPermission(EDIT_PERMISSIONS);
    const input = await readJson(request, updateSchema);
    return ok(await updatePlan(ctx, params.id, input, clientIp(request)));
  } catch (err) {
    return handleApiError("lesson-plans.update", err);
  }
}

/** Removes a plan that has no history (nothing opened, closed or attended). */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireAnyPermission(EDIT_PERMISSIONS);
    return ok(await deletePlan(ctx, params.id, clientIp(request)));
  } catch (err) {
    return handleApiError("lesson-plans.delete", err);
  }
}
