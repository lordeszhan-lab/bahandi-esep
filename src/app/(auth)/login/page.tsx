import { Suspense } from "react";
import { LoginForm } from "./login-form";

function LoginSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div
          className="card p-8 sm:p-10 rounded-2xl"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          {/* Eyebrow placeholder */}
          <div
            className="h-3 w-40 rounded mb-4 animate-pulse"
            style={{ background: "var(--surface-2)" }}
          />
          {/* Heading placeholder */}
          <div
            className="h-8 w-52 rounded mb-2 animate-pulse"
            style={{ background: "var(--surface-2)" }}
          />
          <div
            className="h-4 w-64 rounded mb-8 animate-pulse"
            style={{ background: "var(--surface-2)" }}
          />
          {/* Email field */}
          <div className="space-y-5">
            <div>
              <div
                className="h-3 w-12 rounded mb-2 animate-pulse"
                style={{ background: "var(--surface-2)" }}
              />
              <div
                className="h-10 w-full rounded-xl animate-pulse"
                style={{ background: "var(--surface-2)" }}
              />
            </div>
            {/* Password field */}
            <div>
              <div
                className="h-3 w-16 rounded mb-2 animate-pulse"
                style={{ background: "var(--surface-2)" }}
              />
              <div
                className="h-10 w-full rounded-xl animate-pulse"
                style={{ background: "var(--surface-2)" }}
              />
            </div>
            {/* Button */}
            <div
              className="h-10 w-full rounded-xl mt-2 animate-pulse"
              style={{ background: "var(--primary-soft)" }}
            />
          </div>
        </div>
        <div
          className="h-3 w-56 rounded mx-auto mt-6 animate-pulse"
          style={{ background: "var(--surface-2)" }}
        />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}
