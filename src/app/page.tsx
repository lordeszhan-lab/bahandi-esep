export default function Home() {
  return (
    <main className="min-h-screen bg-canvas flex items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">

        {/* Typography specimen */}
        <div>
          <p className="eyebrow mb-3">СВЕРКА Design System — Prompt 0</p>
          <h1
            style={{ fontSize: "2rem", fontWeight: 800, color: "var(--fg)", lineHeight: 1.1 }}
          >
            Premium&nbsp;+&nbsp;Joy foundation
          </h1>
          <p style={{ color: "var(--fg-muted)", marginTop: "0.5rem" }}>
            Nunito loaded · design tokens live · utility classes ready.
          </p>
        </div>

        {/* Card with shadow lift */}
        <div className="card">
          <p className="eyebrow mb-2">Card component</p>
          <p style={{ color: "var(--fg)", fontWeight: 700, fontSize: "1.125rem" }}>
            Soft shadow, no border, hover lifts −2 px
          </p>
          <p style={{ color: "var(--fg-muted)", fontSize: "0.9375rem", marginTop: "0.25rem" }}>
            bg: --surface · shadow: --shadow-card · radius: 16 px
          </p>

          {/* Buttons row */}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "1.25rem" }}>
            <button className="btn-primary">Primary action</button>
            <button className="btn-ledge">Submit entry</button>
          </div>
        </div>

        {/* Chips */}
        <div className="card">
          <p className="eyebrow mb-3">Loss-type chips (pastel + ink)</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <span className="chip chip-tech">Технологический выход</span>
            <span className="chip chip-quality">Брак качества</span>
            <span className="chip chip-damage">Повреждение</span>
            <span className="chip chip-spoil">Порча / срок</span>
            <span className="chip chip-return">Возврат гостя</span>
            <span className="chip chip-break">Бой</span>
          </div>
        </div>

        {/* Status pills */}
        <div className="card">
          <p className="eyebrow mb-3">Risk-status pills</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <span className="pill-status" data-risk="clean">Approved</span>
            <span className="pill-status" data-risk="watch">In Review</span>
            <span className="pill-status" data-risk="fraud">Rejected</span>
            <span className="pill-status" data-risk="info">Syncing</span>
          </div>
        </div>

        {/* Token swatch — quick visual test */}
        <div className="card">
          <p className="eyebrow mb-3">Brand palette tokens</p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {[
              ["--brand",        "Brand"],
              ["--brand-strong", "Strong"],
              ["--brand-soft",   "Soft"],
              ["--brand-ring",   "Ring"],
            ].map(([token, label]) => (
              <div key={token} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: `var(${token})`,
                    marginBottom: 4,
                    border: "1px solid var(--border)",
                  }}
                />
                <p style={{ fontSize: "0.6875rem", color: "var(--fg-muted)" }}>{label}</p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </main>
  );
}
