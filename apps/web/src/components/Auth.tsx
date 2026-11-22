import { useState, type FormEvent } from "react";
import { ShieldCheck, Sparkles } from "lucide-react";
import type { PublicUser } from "@omp-builder/shared";
import { api } from "../api";
import { BrandMark, Button, Field, inputClass } from "../ui";

export type AuthState = { setupRequired: boolean; user: PublicUser | null };

export function Auth({ status, onAuthenticated }: { status: AuthState; onAuthenticated: (user: PublicUser) => void }) {
  const [email, setEmail] = useState(() => localStorage.getItem("omp-builder-remembered-email") ?? "admin@example.com");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => Boolean(localStorage.getItem("omp-builder-remembered-email")));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = status.setupRequired ? await api.setup(email, password) : await api.login(email, password);
      if (remember) localStorage.setItem("omp-builder-remembered-email", email);
      else localStorage.removeItem("omp-builder-remembered-email");
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen bg-omp-canvas">
      {/* Brand panel — desktop only */}
      <section className="hidden w-[46%] shrink-0 flex-col justify-between bg-omp-nav p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <div className="leading-none">
            <div className="text-2xl font-bold tracking-tight">omp.</div>
            <div className="mt-1 text-[10px] font-medium tracking-[0.18em] text-white/50">AI APP BUILDER</div>
          </div>
        </div>
        <div>
          <h1 className="max-w-md text-4xl font-bold leading-[1.15] tracking-tight">Build amazing things with your own AI.</h1>
          <p className="mt-4 max-w-md text-[15px] leading-7 text-white/65">
            Create, iterate and ship applications with the OMP agent powering your workspace.
          </p>
          <p className="mt-8 flex items-center gap-2 text-sm text-white/80">
            <Sparkles size={15} className="text-omp-brand" /> AI-powered development, under your control
          </p>
          <p className="mt-2 text-sm text-white/50">A workspace designed for creators.</p>
        </div>
        <div className="text-xs leading-5 text-white/40">
          OMP Builder • UI / UX Design System • Implementation handoff • v0.1
        </div>
      </section>

      {/* Form */}
      <section className="flex min-w-0 flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark size={40} />
            <div className="leading-none">
              <div className="text-2xl font-bold tracking-tight">omp.</div>
              <div className="mt-1 text-[10px] font-medium tracking-[0.18em] text-omp-muted">AI APP BUILDER</div>
            </div>
          </div>
          <h2 className="text-[28px] font-bold tracking-tight text-omp-ink">
            {status.setupRequired ? "Create your admin account" : "Welcome back"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-omp-muted">
            {status.setupRequired
              ? "This one-time setup protects your private builder instance."
              : "Sign in to continue building with OMP."}
          </p>
          <form onSubmit={submit} className="mt-8 grid gap-5">
            <Field label="Email address">
              <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} />
            </Field>
            <Field label="Password">
              <input
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={status.setupRequired ? "At least 12 characters" : undefined}
                className={inputClass}
              />
            </Field>
            <div className="flex items-center justify-between text-sm">
              <label className="flex cursor-pointer items-center gap-2 text-omp-muted">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  className="h-4 w-4 accent-omp-brand"
                />
                Remember me
              </label>
              <button
                type="button"
                className="font-medium text-omp-brand hover:underline"
                onClick={() => setNotice("Password reset isn't available in the app yet — the workspace owner can reset the admin password on the server.")}
              >
                Forgot password?
              </button>
            </div>
            {error && (
              <div role="alert" className="rounded-omp border border-[#f6c6c6] bg-[#fdecec] px-3.5 py-2.5 text-sm text-[#a83232]">
                {error}
              </div>
            )}
            {notice && (
              <div role="status" className="rounded-omp border border-omp-border bg-omp-canvas px-3.5 py-2.5 text-sm leading-6 text-omp-muted">
                {notice}
              </div>
            )}
            <Button type="submit" disabled={busy} className="w-full !py-3">
              {busy ? "Working…" : status.setupRequired ? "Create account" : "Sign in"}
            </Button>
          </form>
          <p className="mt-8 flex items-start gap-2.5 rounded-omp border border-omp-border bg-white px-4 py-3 text-xs leading-5 text-omp-muted">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-omp-success" />
            <span>
              <span className="font-semibold text-omp-ink">Secure access to your workspace</span>
              <br />
              Authentication and provider secrets are handled by the backend.
            </span>
          </p>
        </div>
      </section>
    </main>
  );
}
