import { ListChecks } from "lucide-react";
import { getCurrentProfile } from "@/lib/auth";
import { ActionCard } from "@/components/ui/action-card";
import { APP_NAME } from "@/lib/brand";

export const metadata = { title: `Проверка списаний · ${APP_NAME}` };

export default async function ReviewPage() {
  const profile = await getCurrentProfile();

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-12">
      <p className="eyebrow mb-3">Проверяющий</p>
      <h1 className="text-2xl font-extrabold mb-1" style={{ color: "var(--fg)" }}>
        Проверка списаний
      </h1>
      <p className="text-sm mb-10" style={{ color: "var(--fg-muted)" }}>
        Добрый день, {profile?.full_name ?? "проверяющий"}
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        <ActionCard
          icon={ListChecks}
          iconBg="#DCFCE7"
          iconInk="#15803D"
          title="Очередь на проверку"
          subtitle="Входящие списания, ожидающие решения"
        />
      </div>
    </div>
  );
}
