import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireAnyPermission } from "@/lib/rbac";
import { handleApiError, created, readJson, clientIp } from "@/lib/api";
import { addStudentToClosedLesson, ADD_AFTER_CLOSE_PERMISSIONS } from "@/lib/lesson-data";

const schema = z.object({
  studentId: z.string().uuid(),
  type: z.enum(["REGULAR", "LATE", "EXCUSED", "MAKE_UP"]),
  reason: z.string().trim().min(3).max(500)
});

/**
 * Adds a student to a lesson that is already CLOSED (or fixes the ABSENT row that
 * closing created for them). Audited: needs a reason. Allowed for anyone who can
 * record attendance or manage lessons (teacher, assistant, receptionist, admin),
 * because they are the people who realise a student was left out.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requireAnyPermission(ADD_AFTER_CLOSE_PERMISSIONS);
    const input = await readJson(request, schema);
    const result = await addStudentToClosedLesson(ctx, params.id, input, clientIp(request));
    return created(result);
  } catch (err) {
    return handleApiError("sessions.addStudent", err);
  }
}
