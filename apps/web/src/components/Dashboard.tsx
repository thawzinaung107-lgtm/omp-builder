import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Code2, Plus, Search, Sparkles } from "lucide-react";
import type { Project, Provider } from "@omp-builder/shared";
import { Button, Card, StatusChip, dayLabel, statusTone, timeAgo } from "../ui";

type DashboardProps = {
  projects: Project[];
  providers: Provider[];
  onOpen: (project: Project) => void;
  onCreate: () => void;
  onViewAll: () => void;
};

function statusLabel(status: string): string {
  if (status === "running") return "In progress";
  if (status === "ready") return "Ready";
  if (status === "error") return "Error";
  return "Draft";
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: (project: Project) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className="group rounded-omp-lg border border-omp-border bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-omp-brand/40 hover:shadow-lg hover:shadow-omp-brand/[.06]"
    >
      <div className="mb-4 flex items-start justify-between gap-2">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-omp-brandSubtle text-lg font-bold text-omp-brand">◈</span>
        <StatusChip label={statusLabel(project.status)} tone={statusTone(project.status)} />
      </div>
      <div className="font-semibold text-omp-ink">{project.name}</div>
      <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-omp-muted">{project.prompt}</p>
      <div className="mt-4 flex items-center justify-between text-xs text-omp-muted">
        <span>Edited {timeAgo(project.updatedAt)}</span>
        <ArrowRight size={14} className="opacity-0 transition group-hover:opacity-100 group-hover:text-omp-brand" />
      </div>
    </button>
  );
}

function SearchBar({ value, onChange, inputRef }: { value: string; onChange: (value: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <div className="flex items-center gap-2 rounded-omp border border-omp-border bg-white px-3.5 py-2.5">
      <Search size={16} className="shrink-0 text-omp-muted" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search projects..."
        className="w-full bg-transparent text-sm text-omp-ink outline-none placeholder:text-omp-muted/70"
      />
      <kbd className="hidden shrink-0 rounded border border-omp-border bg-omp-canvas px-1.5 py-0.5 text-[11px] text-omp-muted sm:block">⌘ K</kbd>
    </div>
  );
}

export function Dashboard({ projects, providers, onOpen, onCreate, onViewAll }: DashboardProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = new Date();
  const thisMonth = projects.filter((p) => {
    const d = new Date(p.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const running = projects.filter((p) => p.status === "running").length;
  const filtered = useMemo(
    () => projects.filter((p) => `${p.name} ${p.prompt}`.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );
  const recent = [...filtered].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)).slice(0, 3);
  const activity = [...projects]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 3)
    .map((p) => ({ icon: <Code2 size={16} />, title: `${p.name} — ${statusLabel(p.status).toLowerCase()}`, when: dayLabel(p.updatedAt) }));

  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-6 md:px-10 md:pb-10 md:pt-8">
      {/* Header */}
      <div className="mb-6 hidden items-center justify-between gap-4 md:flex">
        <div className="text-sm text-omp-muted">
          Workspace <span className="mx-1 text-omp-border">/</span> <span className="font-medium text-omp-ink">Overview</span>
        </div>
        <div className="w-64">
          <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
        </div>
      </div>

      {/* Mobile greeting */}
      <div className="mb-5 md:hidden">
        <h1 className="text-xl font-bold tracking-tight text-omp-ink">Your workspace</h1>
        <p className="mt-1 text-sm text-omp-muted">Build something amazing today.</p>
        <button
          type="button"
          onClick={onCreate}
          className="mt-4 flex w-full items-center gap-3 rounded-omp-lg border border-omp-border bg-white p-4 text-left"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-omp-brand text-white">
            <Sparkles size={18} />
          </span>
          <span>
            <span className="block text-sm font-semibold text-omp-ink">✦ Create with OMP</span>
            <span className="block text-xs leading-5 text-omp-muted">Start from an idea or an existing project.</span>
          </span>
          <Plus size={18} className="ml-auto shrink-0 text-omp-brand" />
        </button>
      </div>

      {/* Welcome row */}
      <div className="mb-6 hidden items-start justify-between gap-4 md:flex">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-omp-ink">Good to see you again 👋</h1>
          <p className="mt-1.5 text-sm text-omp-muted">Pick up where you left off, or bring your next idea to life.</p>
        </div>
        <Button onClick={onCreate} className="shrink-0">
          <Plus size={16} /> New project
        </Button>
      </div>

      {/* KPIs */}
      <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <Card className="p-4 md:p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Total projects</div>
          <div className="mt-2 text-2xl font-bold text-omp-ink md:text-[28px]">{String(projects.length).padStart(2, "0")}</div>
          <div className="mt-1 text-xs text-omp-success">↑ {thisMonth} created this month</div>
        </Card>
        <Card className="p-4 md:p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Active providers</div>
          <div className="mt-2 text-2xl font-bold text-omp-ink md:text-[28px]">{String(providers.length).padStart(2, "0")}</div>
          <div className="mt-1 text-xs text-omp-muted">{providers.length ? "All connections healthy" : "No providers yet"}</div>
        </Card>
        <Card className="col-span-2 p-4 md:col-span-1 md:p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Running now</div>
          <div className="mt-2 text-2xl font-bold text-omp-ink md:text-[28px]">{String(running).padStart(2, "0")}</div>
          <div className="mt-1 text-xs text-omp-muted">{running ? "Agent sessions active" : "No active builds"}</div>
        </Card>
      </div>

      {/* Recent projects */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-tight text-omp-ink">Recent projects</h2>
        <button type="button" onClick={onViewAll} className="flex items-center gap-1 text-sm font-medium text-omp-brand hover:underline">
          View all <ArrowRight size={14} />
        </button>
      </div>
      {recent.length === 0 ? (
        <Card className="grid place-items-center px-6 py-14 text-center">
          <div>
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
              <Sparkles size={22} />
            </div>
            <h3 className="font-semibold text-omp-ink">Start with a blank canvas</h3>
            <p className="mt-1 text-sm text-omp-muted">Your next project starts with a prompt.</p>
            <Button onClick={onCreate} variant="outline" className="mt-4">
              <Plus size={15} /> Create project
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {recent.map((project) => (
            <ProjectCard key={project.id} project={project} onOpen={onOpen} />
          ))}
        </div>
      )}

      {/* Bottom section */}
      <div className="mt-7 grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className="p-5 md:p-6">
          <h3 className="font-semibold text-omp-ink">Recent activity</h3>
          {activity.length === 0 ? (
            <p className="mt-3 text-sm text-omp-muted">No activity yet — create your first project.</p>
          ) : (
            <div className="mt-4 space-y-4">
              {activity.map((item, index) => (
                <div key={index} className="flex items-start gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-omp-canvas text-omp-muted">{item.icon}</span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-omp-ink">{item.title}</div>
                    <div className="text-xs text-omp-muted">{item.when}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <div className="rounded-omp-lg bg-omp-brandSubtle p-5 md:p-6">
          <h3 className="font-semibold text-omp-ink">✦ Your next build starts here</h3>
          <p className="mt-2 text-sm leading-6 text-omp-muted">Describe your idea. OMP handles the agent workflow while you stay in control.</p>
          <Button onClick={onCreate} className="mt-4">
            Start building <ArrowRight size={15} />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsList({ projects, onOpen, onCreate }: { projects: Project[]; onOpen: (project: Project) => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(
    () => projects.filter((p) => `${p.name} ${p.prompt}`.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-6 md:px-10 md:pb-10 md:pt-8">
      <div className="mb-6 hidden items-center justify-between gap-4 md:flex">
        <div className="text-sm text-omp-muted">
          Workspace <span className="mx-1 text-omp-border">/</span> <span className="font-medium text-omp-ink">My Projects</span>
        </div>
        <div className="w-64">
          <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
        </div>
      </div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-omp-ink md:text-[28px]">My Projects</h1>
          <p className="mt-1 text-sm text-omp-muted">
            {projects.length} project{projects.length === 1 ? "" : "s"} in your workspace.
          </p>
        </div>
        <Button onClick={onCreate} className="shrink-0">
          <Plus size={16} /> New project
        </Button>
      </div>
      <div className="mb-5 md:hidden">
        <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
      </div>
      {filtered.length === 0 ? (
        <Card className="grid place-items-center px-6 py-14 text-center">
          <div>
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
              <Sparkles size={22} />
            </div>
            <h3 className="font-semibold text-omp-ink">{projects.length === 0 ? "No projects yet" : "No matches"}</h3>
            <p className="mt-1 text-sm text-omp-muted">
              {projects.length === 0 ? "Describe an idea and OMP will build it." : "Try a different search."}
            </p>
            {projects.length === 0 && (
              <Button onClick={onCreate} className="mt-4">
                <Plus size={15} /> Create project
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="space-y-2 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 lg:grid-cols-3">
          {filtered.map((project) => (
            <div key={project.id} className="md:hidden">
              <button
                type="button"
                onClick={() => onOpen(project)}
                className="flex w-full items-center gap-3 rounded-omp-lg border border-omp-border bg-white p-4 text-left"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-omp-brandSubtle text-base font-bold text-omp-brand">◈</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-omp-ink">{project.name}</span>
                  <span className="block truncate text-xs text-omp-muted">{statusLabel(project.status)} • Edited {timeAgo(project.updatedAt)}</span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-omp-muted" />
              </button>
            </div>
          ))}
          {filtered.map((project) => (
            <div key={`d-${project.id}`} className="hidden md:block">
              <ProjectCard project={project} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
