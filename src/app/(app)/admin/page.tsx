import { Users, MapPin, BarChart3 } from "lucide-react";
import { getCurrentProfile } from "@/lib/auth";
import { ActionCard } from "@/components/ui/action-card";
import { APP_NAME } from "@/lib/brand";

export const metadata = { title: `Управление · ${APP_NAME}` };

export default async function AdminPage() {
  const profile = await getCurrentProfile();

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-12">
      <p className="eyebrow mb-3">Управление</p>
      <h1 className="text-2xl font-extrabold mb-1" style={{ color: "var(--fg)" }}>
        Добрый день, {profile?.full_name ?? "администратор"}
      </h1>
      <p className="text-sm mb-10" style={{ color: "var(--fg-muted)" }}>
        {APP_NAME} — платформа контроля потерь
      </p>

      <div className="grid sm:grid-cols-3 gap-4">
        <ActionCard
          icon={Users}
          iconBg="#EEF1F4"
          iconInk="#475569"
          title="Пользователи"
          subtitle="Управление ролями и доступом"
        />
        <ActionCard
          icon={MapPin}
          iconBg="#D7F5F0"
          iconInk="#0F766E"
          title="Локации"
          subtitle="Точки продаж и геозоны"
        />
        <ActionCard
          icon={BarChart3}
          iconBg="#E0F4FE"
          iconInk="#0369A1"
          title="Аналитика"
          subtitle="Отчёты по списаниям и рискам"
        />
      </div>
    </div>
  );
}
