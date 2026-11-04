import { assertGroupInScope, groupIdFilter, resolveOwnGroupIds } from "./group-access";
import type { DayOfWeek, Prisma } from "@prisma/client";
import { db } from "./db";
import { BusinessRuleError, NotFoundError } from "./api";
import { writeAuditLog } from "./audit";
import { resolveBranchScope, type AuthContext } from "./rbac";
import { toDateOnly } from "./sessions";
import {
  computePlanEdit,
  generateMonthlyLessons,
  slotOccurrencesInMonth,
  validateConfirmedLessons,
  weekdayOf,
  type WeekdayName,
  type ExistingPlanLesson,
  type LessonPlanWarning,
  type PlannedLesson,
  type ScheduleSlot
} from "./lesson-plan";
import { isPlanDeletable, planProgress, type LessonStatus } from "./lesson-flow";

/**
 * Database side of lesson formation (تشكيل الحصص). The date arithmetic is in
 * lesson-plan.ts; this file loads the group, enforces the preconditions and
 * persists the reviewed plan atomically.
 */

export interface PlanningGroup {
  id: string;
  name: string;
  branchId: string;
  subject: { id: string; name: string };
  teacher: { id: string; fullName: string };
  assistantId: string | null;
  grade: { id: string; name: string; stage: { id: string; name: string } };
  slots: ScheduleSlot[];
}

/** Loads a group for planning and checks that it has everything a lesson needs. */
export async function loadGroupForPlanning(ctx: AuthContext, groupId: string): Promise<PlanningGroup> {
  const group = await db.group.findFirst({
    where: {
      id: groupId,
      deletedAt: null,
      branch: { deletedAt: null, center: { organizationId: ctx.organizationId } }
    },
    include: {
      grade: { include: { stage: true } },
      subject: true,
      teacher: true,
      schedules: { where: { isActive: true }, orderBy: [{ dayOfWeek: "asc" }, { startMinutes: "asc" }] }
    }
  });
  if (!group) throw new NotFoundError("Group not found.");
  resolveBranchScope(ctx, group.branchId);
  // A teacher / assistant may only form the lessons of the groups he is responsible for.
  assertGroupInScope(await resolveOwnGroupIds(ctx), group.id);

  if (!group.isActive) {
    throw new BusinessRuleError("This group is inactive. Lessons cannot be formed for it.", {
      code: "GROUP_INACTIVE"
    });
  }
  if (!group.subject || group.subject.deletedAt) {
    throw new BusinessRuleError("Assign a subject to this group before forming its lessons.", {
      code: "GROUP_HAS_NO_SUBJECT"
    });
  }
  if (!group.teacher || group.teacher.deletedAt) {
    throw new BusinessRuleError("Assign a teacher to this group before forming its lessons.", {
      code: "GROUP_HAS_NO_TEACHER"
    });
  }
  if (group.schedules.length === 0) {
    throw new BusinessRuleError("This group has no weekly schedule. Add its days and times first.", {
      code: "GROUP_HAS_NO_SCHEDULE"
    });
  }

  return {
    id: group.id,
    name: group.name,
    branchId: group.branchId,
    subject: { id: group.subject.id, name: group.subject.name },
    teacher: { id: group.teacher.id, fullName: group.teacher.fullName },
    assistantId: group.assistantId,
    grade: {
      id: group.grade.id,
      name: group.grade.name,
      stage: { id: group.grade.stage.id, name: group.grade.stage.name }
    },
    slots: group.schedules.map((s) => ({
      dayOfWeek: s.dayOfWeek as DayOfWeek,
      startMinutes: s.startMinutes,
      endMinutes: s.endMinutes
    }))
  };
}

export interface PlanPreview {
  group: PlanningGroup;
  year: number;
  month: number;
  lessonsPerWeek: number;
  appliedLessonsPerWeek: number;
  weeksInMonth: number;
  warnings: LessonPlanWarning[];
  existingPlan: { id: string; lessonsPerWeek: number; lessonCount: number } | null;
  lessons: (PlannedLesson & {
    /** A pre-existing (legacy) session in this exact slot that the plan will adopt. */
    adoptsSessionId: string | null;
    adoptsStatus: LessonStatus | null;
    adoptsAttendanceCount: number;
  })[];
}

export async function previewPlan(
  ctx: AuthContext,
  input: { groupId: string; year: number; month: number; lessonsPerWeek: number }
): Promise<PlanPreview> {
  const group = await loadGroupForPlanning(ctx, input.groupId);

  const generated = generateMonthlyLessons({
    year: input.year,
    month: input.month,
    slots: group.slots,
    lessonsPerWeek: input.lessonsPerWeek
  });

  const [plan, legacy] = await Promise.all([
    db.lessonPlan.findUnique({
      where: { groupId_year_month: { groupId: group.id, year: input.year, month: input.month } },
      select: { id: true, lessonsPerWeek: true, _count: { select: { sessions: true } } }
    }),
    db.classSession.findMany({
      where: {
        groupId: group.id,
        date: { in: generated.lessons.map((l) => toDateOnly(l.date)) },
        planId: null
      },
      select: { id: true, date: true, startMinutes: true, status: true, _count: { select: { attendances: true } } }
    })
  ]);
  const legacyBySlot = new Map(legacy.map((s) => [`${s.date.toISOString().slice(0, 10)}|${s.startMinutes}`, s]));

  return {
    group,
    year: input.year,
    month: input.month,
    lessonsPerWeek: input.lessonsPerWeek,
    appliedLessonsPerWeek: generated.appliedLessonsPerWeek,
    weeksInMonth: generated.weeksInMonth,
    warnings: generated.warnings,
    existingPlan: plan
      ? { id: plan.id, lessonsPerWeek: plan.lessonsPerWeek, lessonCount: plan._count.sessions }
      : null,
    lessons: generated.lessons.map((lesson) => {
      const existing = legacyBySlot.get(`${lesson.date}|${lesson.startMinutes}`);
      return {
        ...lesson,
        adoptsSessionId: existing?.id ?? null,
        adoptsStatus: (existing?.status as LessonStatus | undefined) ?? null,
        adoptsAttendanceCount: existing?._count.attendances ?? 0
      };
    })
  };
}

export async function createPlan(
  ctx: AuthContext,
  input: {
    groupId: string;
    year: number;
    month: number;
    lessonsPerWeek: number;
    lessons: { date: string; startMinutes: number }[];
  },
  ipAddress?: string
) {
  const group = await loadGroupForPlanning(ctx, input.groupId);

  // The client only chooses WHICH of the real slot dates to keep. Dates, times
  // and numbers are rebuilt from the group's schedule on the server.
  const validated = validateConfirmedLessons({
    year: input.year,
    month: input.month,
    slots: group.slots,
    confirmed: input.lessons
  });
  if (!validated.ok) {
    throw new BusinessRuleError(
      validated.reason === "NO_LESSONS"
        ? "Select at least one lesson."
        : validated.reason === "DUPLICATE_DATE"
          ? `The lesson on ${validated.date} was submitted twice.`
          : `${validated.date} is not one of this group's scheduled lesson days.`,
      { status: 400, code: validated.reason }
    );
  }

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.lessonPlan.findUnique({
      where: { groupId_year_month: { groupId: group.id, year: input.year, month: input.month } },
      select: { id: true }
    });
    if (existing) {
      throw new BusinessRuleError(
        "Lessons were already formed for this group in this month. Existing lesson history is never overwritten.",
        { status: 409, code: "PLAN_EXISTS", details: { planId: existing.id } }
      );
    }

    const plan = await tx.lessonPlan.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: group.branchId,
        groupId: group.id,
        year: input.year,
        month: input.month,
        lessonsPerWeek: input.lessonsPerWeek,
        createdById: ctx.userId
      }
    });

    let created = 0;
    let adopted = 0;
    for (const lesson of validated.lessons) {
      const date = toDateOnly(lesson.date);
      const legacy = await tx.classSession.findUnique({
        where: {
          groupId_date_startMinutes: { groupId: group.id, date, startMinutes: lesson.startMinutes }
        },
        select: { id: true, planId: true }
      });

      if (legacy && legacy.planId === null) {
        // A session for this exact slot already exists (made by the old
        // generator or scanner). Keep it — and its attendance — and number it.
        await tx.classSession.update({
          where: { id: legacy.id },
          data: { planId: plan.id, lessonNumber: lesson.lessonNumber }
        });
        adopted += 1;
      } else if (legacy) {
        throw new BusinessRuleError("A lesson for this slot already belongs to another plan.", {
          status: 409,
          code: "SLOT_TAKEN"
        });
      } else {
        await tx.classSession.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: group.branchId,
            groupId: group.id,
            teacherId: group.teacher.id,
            assistantId: group.assistantId,
            date,
            startMinutes: lesson.startMinutes,
            endMinutes: lesson.endMinutes,
            planId: plan.id,
            lessonNumber: lesson.lessonNumber
          }
        });
        created += 1;
      }
    }
    return { plan, created, adopted };
    // A month has up to ~31 lessons with two queries each — more than the 5 s default.
  }, { timeout: 30000, maxWait: 10000 });

  await writeAuditLog({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "CREATE_LESSON_PLAN",
    entityType: "LessonPlan",
    entityId: result.plan.id,
    afterValue: {
      groupId: group.id,
      year: input.year,
      month: input.month,
      lessonsPerWeek: input.lessonsPerWeek,
      lessons: validated.lessons.length,
      created: result.created,
      adopted: result.adopted
    },
    ipAddress
  });

  return { planId: result.plan.id, created: result.created, adopted: result.adopted, total: validated.lessons.length };
}

export interface ListedPlan {
  id: string;
  year: number;
  month: number;
  lessonsPerWeek: number;
  group: {
    id: string;
    name: string;
    grade: { id: string; name: string; stage: { id: string; name: string } };
    subject: { id: string; name: string } | null;
    teacher: { id: string; fullName: string } | null;
  };
  lessons: {
    id: string;
    lessonNumber: number | null;
    date: Date;
    startMinutes: number;
    endMinutes: number;
    status: LessonStatus;
    attendanceCount: number;
  }[];
  progress: ReturnType<typeof planProgress>;
  deletable: boolean;
}

export async function listPlans(
  ctx: AuthContext,
  filter: {
    branchId?: string;
    groupId?: string;
    stageId?: string;
    gradeId?: string;
    subjectId?: string;
    year?: number;
    month?: number;
  }
): Promise<ListedPlan[]> {
  const branchIds = resolveBranchScope(ctx, filter.branchId);
  const ownGroupIds = await resolveOwnGroupIds(ctx);

  const groupWhere: Prisma.GroupWhereInput = {
    ...(filter.gradeId ? { gradeId: filter.gradeId } : {}),
    ...(filter.stageId ? { grade: { stageId: filter.stageId } } : {}),
    ...(filter.subjectId ? { subjectId: filter.subjectId } : {})
  };

  const plans = await db.lessonPlan.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
      ...groupIdFilter(ownGroupIds, filter.groupId),
      ...(filter.year ? { year: filter.year } : {}),
      ...(filter.month ? { month: filter.month } : {}),
      ...(Object.keys(groupWhere).length ? { group: groupWhere } : {})
    },
    orderBy: [{ year: "desc" }, { month: "desc" }, { group: { name: "asc" } }],
    take: 200,
    include: {
      group: {
        select: {
          id: true,
          name: true,
          grade: { select: { id: true, name: true, stage: { select: { id: true, name: true } } } },
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, fullName: true } }
        }
      },
      sessions: {
        orderBy: { lessonNumber: "asc" },
        select: {
          id: true,
          lessonNumber: true,
          date: true,
          startMinutes: true,
          endMinutes: true,
          status: true,
          _count: { select: { attendances: { where: { deletedAt: null } } } }
        }
      }
    }
  });

  return plans.map((plan) => {
    const lessons = plan.sessions.map((s) => ({
      id: s.id,
      lessonNumber: s.lessonNumber,
      date: s.date,
      startMinutes: s.startMinutes,
      endMinutes: s.endMinutes,
      status: s.status as LessonStatus,
      attendanceCount: s._count.attendances
    }));
    return {
      id: plan.id,
      year: plan.year,
      month: plan.month,
      lessonsPerWeek: plan.lessonsPerWeek,
      group: plan.group,
      lessons,
      progress: planProgress(lessons),
      deletable: isPlanDeletable(lessons)
    };
  });
}

/**
 * Removes a plan that has no history at all (every lesson still SCHEDULED with
 * zero attendance), so a plan formed by mistake can be redone. Anything that
 * has been opened, closed or attended is history and is never deleted.
 */
export async function deletePlan(ctx: AuthContext, planId: string, ipAddress?: string) {
  const plan = await db.lessonPlan.findFirst({
    where: {
      id: planId,
      organizationId: ctx.organizationId,
      ...(ctx.isOrgWide ? {} : { branchId: { in: ctx.branchIds } })
    },
    include: {
      sessions: { select: { id: true, status: true, _count: { select: { attendances: true } } } }
    }
  });
  if (!plan) throw new NotFoundError("Lesson plan not found.");
  assertGroupInScope(await resolveOwnGroupIds(ctx), plan.groupId);

  const deletable = isPlanDeletable(
    plan.sessions.map((s) => ({ status: s.status as LessonStatus, attendanceCount: s._count.attendances }))
  );
  if (!deletable) {
    throw new BusinessRuleError(
      "This plan already has opened, closed or attended lessons. Its history cannot be deleted.",
      { code: "PLAN_HAS_HISTORY" }
    );
  }

  await db.$transaction(async (tx) => {
    await tx.classSession.deleteMany({
      where: { planId: plan.id, status: "SCHEDULED", attendances: { none: {} } }
    });
    await tx.lessonPlan.delete({ where: { id: plan.id } });
  });

  await writeAuditLog({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "DELETE_LESSON_PLAN",
    entityType: "LessonPlan",
    entityId: plan.id,
    beforeValue: { groupId: plan.groupId, year: plan.year, month: plan.month, lessons: plan.sessions.length },
    ipAddress
  });

  return { id: plan.id, removedLessons: plan.sessions.length };
}

/* ------------------------------------------------------------------ */
/* Editing a formed plan                                               */
/* ------------------------------------------------------------------ */

/** A lesson is locked (never removable) once it has any history or linked work. */
function isLessonLocked(s: {
  status: string;
  _count: { attendances: number; assignments: number };
  recitationSession: { id: string } | null;
}): boolean {
  return (
    s.status !== "SCHEDULED" || s._count.attendances > 0 || s._count.assignments > 0 || s.recitationSession !== null
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Loads a plan inside the caller's scope, with its group and every lesson. */
async function loadPlanScoped(ctx: AuthContext, planId: string) {
  const plan = await db.lessonPlan.findFirst({
    where: {
      id: planId,
      organizationId: ctx.organizationId,
      ...(ctx.isOrgWide ? {} : { branchId: { in: ctx.branchIds } })
    },
    include: {
      group: {
        include: {
          grade: { include: { stage: true } },
          subject: true,
          teacher: true,
          schedules: { where: { isActive: true }, orderBy: [{ dayOfWeek: "asc" }, { startMinutes: "asc" }] }
        }
      },
      sessions: {
        orderBy: [{ date: "asc" }, { startMinutes: "asc" }],
        include: {
          _count: { select: { attendances: true, assignments: true } },
          recitationSession: { select: { id: true } }
        }
      }
    }
  });
  if (!plan) throw new NotFoundError("Lesson plan not found.");
  assertGroupInScope(await resolveOwnGroupIds(ctx), plan.groupId);
  return plan;
}

export interface PlanEditRow {
  date: string;
  dayOfWeek: WeekdayName;
  startMinutes: number;
  endMinutes: number;
  /** null → a real slot date that is not (yet) part of the plan. */
  sessionId: string | null;
  lessonNumber: number | null;
  status: LessonStatus | null;
  attendanceCount: number;
  /** Cannot be removed: opened / completed / cancelled / attended / has recitation or homework. */
  locked: boolean;
  /** A pre-existing (legacy) session in this slot that adding the date will adopt. */
  adoptsSessionId: string | null;
}

export interface PlanEditView {
  plan: { id: string; year: number; month: number; lessonsPerWeek: number };
  group: {
    id: string;
    name: string;
    grade: { id: string; name: string; stage: { id: string; name: string } };
    subject: { id: string; name: string } | null;
    teacher: { id: string; fullName: string } | null;
  };
  slots: ScheduleSlot[];
  rows: PlanEditRow[];
}

/** Everything the edit screen needs: the plan's lessons plus the month's other real slot dates. */
export async function getPlanForEdit(ctx: AuthContext, planId: string): Promise<PlanEditView> {
  const plan = await loadPlanScoped(ctx, planId);
  const slots: ScheduleSlot[] = plan.group.schedules.map((s) => ({
    dayOfWeek: s.dayOfWeek as DayOfWeek,
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes
  }));

  const inPlan = new Map(plan.sessions.map((s) => [`${iso(s.date)}|${s.startMinutes}`, s]));
  const occurrences = slotOccurrencesInMonth(plan.year, plan.month, slots);
  const free = occurrences.filter((o) => !inPlan.has(`${o.date}|${o.startMinutes}`));

  const legacy = free.length
    ? await db.classSession.findMany({
        where: { groupId: plan.groupId, planId: null, date: { in: free.map((o) => toDateOnly(o.date)) } },
        select: { id: true, date: true, startMinutes: true }
      })
    : [];
  const legacyBySlot = new Map(legacy.map((s) => [`${iso(s.date)}|${s.startMinutes}`, s.id]));

  const rows: PlanEditRow[] = [
    ...plan.sessions.map((s) => ({
      date: iso(s.date),
      dayOfWeek: weekdayOf(s.date),
      startMinutes: s.startMinutes,
      endMinutes: s.endMinutes,
      sessionId: s.id,
      lessonNumber: s.lessonNumber,
      status: s.status as LessonStatus,
      attendanceCount: s._count.attendances,
      locked: isLessonLocked(s),
      adoptsSessionId: null
    })),
    ...free.map((o) => ({
      date: o.date,
      dayOfWeek: o.dayOfWeek,
      startMinutes: o.startMinutes,
      endMinutes: o.endMinutes,
      sessionId: null,
      lessonNumber: null,
      status: null,
      attendanceCount: 0,
      locked: false,
      adoptsSessionId: legacyBySlot.get(`${o.date}|${o.startMinutes}`) ?? null
    }))
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes);

  return {
    plan: { id: plan.id, year: plan.year, month: plan.month, lessonsPerWeek: plan.lessonsPerWeek },
    group: {
      id: plan.group.id,
      name: plan.group.name,
      grade: {
        id: plan.group.grade.id,
        name: plan.group.grade.name,
        stage: { id: plan.group.grade.stage.id, name: plan.group.grade.stage.name }
      },
      subject: plan.group.subject ? { id: plan.group.subject.id, name: plan.group.subject.name } : null,
      teacher: plan.group.teacher ? { id: plan.group.teacher.id, fullName: plan.group.teacher.fullName } : null
    },
    slots,
    rows
  };
}

/**
 * Edits a formed plan: add or remove dates and change lessons/week.
 *  - Lessons with history (opened, completed, cancelled, attended, recitation,
 *    homework) are always kept — the client cannot remove them.
 *  - Untouched lessons keep their id (so nothing linked to them is lost).
 *  - All remaining lessons are renumbered 1..n chronologically.
 */
export async function updatePlan(
  ctx: AuthContext,
  planId: string,
  input: { lessonsPerWeek: number; lessons: { date: string; startMinutes: number }[] },
  ipAddress?: string
) {
  const plan = await loadPlanScoped(ctx, planId);
  const slots: ScheduleSlot[] = plan.group.schedules.map((s) => ({
    dayOfWeek: s.dayOfWeek as DayOfWeek,
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes
  }));

  const existing: ExistingPlanLesson[] = plan.sessions.map((s) => ({
    id: s.id,
    date: iso(s.date),
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes,
    locked: isLessonLocked(s)
  }));

  const edit = computePlanEdit({
    year: plan.year,
    month: plan.month,
    slots,
    existing,
    requested: input.lessons
  });
  if (!edit.ok) {
    throw new BusinessRuleError(
      edit.reason === "NO_LESSONS"
        ? "Select at least one lesson, or delete the plan."
        : edit.reason === "DUPLICATE_DATE"
          ? `The lesson on ${edit.date} was submitted twice.`
          : `${edit.date} is not one of this group's scheduled lesson days.`,
      { status: 400, code: edit.reason }
    );
  }

  if (edit.add.length > 0) {
    if (!plan.group.isActive) {
      throw new BusinessRuleError("This group is inactive. Lessons cannot be added to it.", { code: "GROUP_INACTIVE" });
    }
    if (!plan.group.teacher || plan.group.teacher.deletedAt) {
      throw new BusinessRuleError("Assign a teacher to this group before adding lessons.", {
        code: "GROUP_HAS_NO_TEACHER"
      });
    }
  }

  const byId = new Map(plan.sessions.map((s) => [s.id, s]));
  const changedNumbers = edit.keep.filter((k) => byId.get(k.id)?.lessonNumber !== k.lessonNumber);

  const result = await db.$transaction(
    async (tx) => {
      // 1. Remove the unticked lessons — only if they are STILL untouched.
      let removed = 0;
      if (edit.remove.length > 0) {
        const res = await tx.classSession.deleteMany({
          where: {
            id: { in: edit.remove },
            planId: plan.id,
            status: "SCHEDULED",
            attendances: { none: {} },
            assignments: { none: {} },
            recitationSession: null
          }
        });
        if (res.count !== edit.remove.length) {
          throw new BusinessRuleError(
            "A lesson was opened or changed while you were editing. Reload the page and try again.",
            { status: 409, code: "LESSON_CHANGED" }
          );
        }
        removed = res.count;
      }

      // 2. Park the kept lessons whose number changes on temporary negative numbers,
      //    so the (planId, lessonNumber) unique index never collides mid-way.
      for (const k of changedNumbers) {
        await tx.classSession.update({ where: { id: k.id }, data: { lessonNumber: -k.lessonNumber } });
      }

      // 3. Add the new dates (adopting a legacy session in the same slot, like createPlan does).
      let created = 0;
      let adopted = 0;
      for (const lesson of edit.add) {
        const date = toDateOnly(lesson.date);
        const legacy = await tx.classSession.findUnique({
          where: { groupId_date_startMinutes: { groupId: plan.groupId, date, startMinutes: lesson.startMinutes } },
          select: { id: true, planId: true }
        });
        if (legacy && legacy.planId === null) {
          await tx.classSession.update({
            where: { id: legacy.id },
            data: { planId: plan.id, lessonNumber: lesson.lessonNumber }
          });
          adopted += 1;
        } else if (legacy) {
          throw new BusinessRuleError("A lesson for this slot already belongs to another plan.", {
            status: 409,
            code: "SLOT_TAKEN"
          });
        } else {
          await tx.classSession.create({
            data: {
              organizationId: ctx.organizationId,
              branchId: plan.branchId,
              groupId: plan.groupId,
              teacherId: plan.group.teacher!.id,
              assistantId: plan.group.assistantId,
              date,
              startMinutes: lesson.startMinutes,
              endMinutes: lesson.endMinutes,
              planId: plan.id,
              lessonNumber: lesson.lessonNumber
            }
          });
          created += 1;
        }
      }

      // 4. Final numbers for the parked lessons.
      for (const k of changedNumbers) {
        await tx.classSession.update({ where: { id: k.id }, data: { lessonNumber: k.lessonNumber } });
      }

      await tx.lessonPlan.update({ where: { id: plan.id }, data: { lessonsPerWeek: input.lessonsPerWeek } });
      return { removed, created, adopted };
    },
    { timeout: 30000, maxWait: 10000 }
  );

  await writeAuditLog({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "UPDATE_LESSON_PLAN",
    entityType: "LessonPlan",
    entityId: plan.id,
    beforeValue: {
      lessonsPerWeek: plan.lessonsPerWeek,
      lessons: existing.map((l) => `${l.date} ${l.startMinutes}`)
    },
    afterValue: {
      lessonsPerWeek: input.lessonsPerWeek,
      removed: result.removed,
      created: result.created,
      adopted: result.adopted,
      total: edit.keep.length + edit.add.length
    },
    ipAddress
  });

  return { planId: plan.id, ...result, total: edit.keep.length + edit.add.length };
}
