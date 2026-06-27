"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/brand";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setError(null);
  }, [email, password]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(
        authError.message === "Invalid login credentials"
          ? "Неверный email или пароль"
          : authError.message,
      );
      setIsLoading(false);
      return;
    }

    // Proxy routes / → role home; preserve deep-link ?next= if present
    const next = searchParams.get("next") ?? "/";
    router.push(next);
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="card p-8 sm:p-10">
          {/* Eyebrow */}
          <p className="eyebrow mb-4">
            
          </p>

          {/* Heading */}
          <h1
            className="text-3xl leading-tight mb-1"
            style={{ fontWeight: 800, color: "var(--fg)" }}
          >
            Войти в систему
          </h1>
          <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
            Используйте корпоративный email
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div>
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                aria-invalid={error != null ? "true" : undefined}
                placeholder="name@bahandi.kz"
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="password" className="label">
                Пароль
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                aria-invalid={error != null ? "true" : undefined}
                placeholder="••••••••"
                disabled={isLoading}
              />
            </div>

            {error && (
              <p
                role="alert"
                className="text-sm font-semibold rounded-xl px-4 py-2.5"
                style={{
                  background: "var(--risk-fraud-soft)",
                  color: "var(--risk-fraud-ink)",
                }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="btn-primary w-full mt-2"
              style={{ justifyContent: "center" }}
            >
              {isLoading ? "Входим…" : "Войти"}
            </button>
          </form>
        </div>

        <p
          className="text-center text-xs mt-6"
          style={{ color: "var(--fg-faint)" }}
        >
          Доступ только для авторизованных сотрудников
        </p>
      </div>
    </div>
  );
}
