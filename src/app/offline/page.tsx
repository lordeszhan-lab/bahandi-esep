import type { Metadata } from "next";

/**
 * Offline shell — served by the service worker when a navigation fails while
 * the device is offline (Prompt 23.1). Public + unauthenticated by design: the
 * auth proxy skips it and the SW precaches it on install. On-system styled
 * (canvas bg, surface card, Nunito) — no joy.
 */
export const metadata: Metadata = {
  title: "Нет соединения — Bahandi esep",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className="offline-shell">
      <div className="card offline-card">
        <div className="offline-mark" aria-hidden="true">
          E
        </div>
        <h1 className="offline-title">Нет соединения</h1>
        <p className="offline-body">
          Подключитесь к сети и обновите страницу. Ваши списания сохранены и
          будут отправлены автоматически.
        </p>
      </div>
    </main>
  );
}
