"use client";

import { useParams, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { useApi } from "@/lib/client";
import { ErrorNotice, PageHeader } from "@/components/ui";
import { Barcode } from "@/components/Barcode";

interface ProfileData {
  student: {
    id: string;
    studentCode: string;
    fullName: string;
  };
}

/**
 * Barcode sticker printing (spec §6, §7).
 *
 * The sticker contains only: barcode, student name, student ID.
 * Paper size and margins are controlled entirely from the browser's print
 * dialog / printer settings — the app does not force any size. The sticker
 * stretches to fill whatever page size the printer is set to.
 */
export default function StudentCardPage() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { data, loading, error } = useApi<ProfileData>(`/api/students/${params.id}/profile`);

  if (loading || !data) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("students.card")} />
        <ErrorNotice message={error} />
        {loading && <p className="text-sm text-black/50 dark:text-white/50">{t("common.loading")}</p>}
      </div>
    );
  }

  const { student } = data;

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <PageHeader title={t("students.card")} />
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary" onClick={() => router.push(`/dashboard/students/${student.id}`)}>
            {t("common.back")}
          </button>
          <button type="button" className="btn-primary" onClick={() => window.print()}>
            {t("common.print")}
          </button>
        </div>
      </div>

      <ErrorNotice message={error} />

      {/* On screen: a preview card. In print: fills the whole page (see .student-sticker in globals.css). */}
      <div className="student-sticker print-sheet card mx-auto flex w-full max-w-xs flex-col items-center justify-start gap-1 bg-white p-3 text-center text-black">
        <p className="w-full break-words text-sm font-bold leading-tight">{student.fullName}</p>

        {/* The exact value stored in Student.studentCode — what the attendance scanner looks up.
            The digits printed under the bars are the student ID. */}
        <Barcode value={student.studentCode} invalidLabel={t("students.barcodeInvalid")} />
      </div>
    </div>
  );
}
