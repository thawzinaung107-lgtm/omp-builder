import type { ReactNode } from "react";

/* Shared primitives matching the Figma OMP design system. */

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function dayLabel(iso: string): string {
  const then = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay(then, today)) return `Today • ${time}`;
  if (sameDay(then, yesterday)) return `Yesterday • ${time}`;
  return `${then.toLocaleDateString("en-US", { month: "short", day: "numeric" })} • ${time}`;
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl bg-omp-brand font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.55 }}
      aria-hidden
    >
      ◈
    </span>
  );
}

type ButtonProps = {
  children: ReactNode;
  variant?: "primary" | "subtle" | "outline" | "ghost" | "danger";
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  title?: string;
  // Milestone E (B3) — forwarded to the <button> so callers can label
  // icon/text buttons for tests and assistive tech. Without this the
  // prop is silently dropped (tsc does not flag unknown props here).
  "aria-label"?: string;
};

export function Button({ children, variant = "primary", onClick, type = "button", disabled = false, className = "", title, "aria-label": ariaLabel }: ButtonProps) {
  const classes = {
    primary: "bg-omp-brand text-white shadow-sm hover:bg-omp-brandHover",
    subtle: "bg-omp-brandSubtle text-omp-brand hover:bg-[#e2dbff]",
    outline: "border border-omp-border bg-white text-omp-ink hover:border-omp-brand/50 hover:bg-omp-canvas",
    ghost: "text-omp-muted hover:bg-black/[.04] hover:text-omp-ink",
    danger: "bg-[#fdecec] text-[#c73e3e] hover:bg-[#fbdede]",
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center justify-center gap-2 rounded-omp px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${classes[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function StatusChip({ label, tone = "brand" }: { label: string; tone?: "brand" | "success" | "warn" | "error" | "muted" }) {
  const tones = {
    brand: "bg-omp-brandSubtle text-omp-brand",
    success: "bg-[#e3f7f0] text-omp-success",
    warn: "bg-[#fef3e2] text-[#9a6b12]",
    error: "bg-[#fdecec] text-[#c73e3e]",
    muted: "bg-black/[.05] text-omp-muted",
  };
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>
      {label}
    </span>
  );
}

export function statusTone(status: string): "brand" | "success" | "warn" | "error" | "muted" {
  if (status === "running") return "brand";
  if (status === "ready") return "success";
  if (status === "error") return "error";
  return "muted";
}

export const inputClass =
  "w-full rounded-omp border border-omp-border bg-white px-3.5 py-2.5 text-sm text-omp-ink outline-none transition placeholder:text-omp-muted/70 focus:border-omp-brand focus:ring-2 focus:ring-omp-brand/15";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-omp-ink">{label}</span>
      {children}
      {hint && <span className="text-xs leading-5 text-omp-muted">{hint}</span>}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-omp-lg border border-omp-border bg-white ${className}`}>{children}</div>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-omp-brand" : "bg-[#d3d8e6]"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center px-6 py-14 text-center">
      <div>
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">{icon}</div>
        <h3 className="font-semibold text-omp-ink">{title}</h3>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-omp-muted">{body}</p>
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
