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
      <style>{`@media print { @page { size: auto; margin: 0; } }`}</style>

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

      <div className="student-sticker print-sheet card mx-auto flex w-full max-w-xs flex-col items-center justify-center gap-1 bg-white p-3 text-center text-black">
        <p className="w-full break-words text-sm font-bold leading-tight">{student.fullName}</p>
        <Barcode value={student.studentCode} invalidLabel={t("students.barcodeInvalid")} />
      </div>
    </div>
  );
}
