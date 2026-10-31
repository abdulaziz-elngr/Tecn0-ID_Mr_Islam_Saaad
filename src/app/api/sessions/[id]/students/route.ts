import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/rbac";
import { handleApiError, created, readJson, clientIp } from "@/lib/api";
import { addStudentToClosedLesson } from "@/lib/lesson-data";

const schema = z.object({
  studentId: z.string().uuid(),
  type: z.enum(["REGULAR", "LATE", "EXCUSED", "MAKE_UP"]),
  reason: z.string().trim().min(3).max(500)
});

/**
 * Adds a student to a lesson that is already CLOSED (or fixes the ABSENT row that
 * closing created for them). Audited: needs a reason and `attendance.update`,
 * the same permission as any other correction of a closed lesson.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ctx = await requirePermission("attendance.update");
    const input = await readJson(request, schema);
    const result = await addStudentToClosedLesson(ctx, params.id, input, clientIp(request));
    return created(result);
  } catch (err) {
    return handleApiError("sessions.addStudent", err);
  }
}
