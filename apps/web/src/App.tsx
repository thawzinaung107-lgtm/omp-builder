import { useEffect, useState } from "react";
import { GitBranch, LogOut, Menu } from "lucide-react";
import type { Project, Provider, PublicUser } from "@omp-builder/shared";
import { api } from "./api";
import { Auth, type AuthState } from "./components/Auth";
import { Builder } from "./components/Builder";
import { Dashboard, ProjectsList } from "./components/Dashboard";
import { NewProject } from "./components/NewProject";
import { Providers } from "./components/Providers";
import { DesktopSidebar, MobileBottomNav, MobileDrawer, type NavScreen } from "./components/Sidebar";
import { BrandMark, Button, Card } from "./ui";

const screenTitles: Record<NavScreen, string> = {
  dashboard: "Overview",
  projects: "My Projects",
  builder: "Build Studio",
  providers: "AI Providers",
  github: "GitHub",
  settings: "Settings",
};

function GitHubView({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-6 md:px-10 md:pb-10 md:pt-8">
      <div className="mb-6 hidden text-sm text-omp-muted md:block">
        Settings <span className="mx-1 text-omp-border">/</span> <span className="font-medium text-omp-ink">GitHub</span>
      </div>
      <Card className="grid place-items-center px-6 py-14 text-center">
        <div>
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-omp-brandSubtle text-omp-brand">
            <GitBranch size={22} />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-omp-ink">GitHub integration arrives in Phase 4</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-omp-muted">
            Clone, status, commit, pull, push and branch history will live here, with explicit confirmation for destructive
            actions. Project workspaces are already versioned on the server.
          </p>
          <Button onClick={onBack} className="mt-5">
            Back to projects
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SettingsView({ user, projects, providers, onLogout }: { user: PublicUser; projects: Project[]; providers: Provider[]; onLogout: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-6 md:px-10 md:pb-10 md:pt-8">
      <div className="mb-6 hidden text-sm text-omp-muted md:block">
        Settings <span className="mx-1 text-omp-border">/</span> <span className="font-medium text-omp-ink">Settings</span>
      </div>
      <h1 className="mb-6 text-2xl font-bold tracking-tight text-omp-ink md:text-[28px]">Settings</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="font-semibold text-omp-ink">Workspace</h2>
          <div className="mt-4 flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-omp-brand text-base font-bold text-white">
              {user.email[0].toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium text-omp-ink">{user.email}</div>
              <div className="text-xs text-omp-muted">Admin workspace • Owner</div>
            </div>
          </div>
          <div className="mt-5 space-y-2 text-sm text-omp-muted">
            <div className="flex justify-between gap-3">
              <span>Projects</span>
              <span className="font-medium text-omp-ink">{projects.length}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Providers</span>
              <span className="font-medium text-omp-ink">{providers.length}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Version</span>
              <span className="font-medium text-omp-ink">OMP Builder v0.1.0</span>
            </div>
          </div>
          <Button variant="outline" onClick={onLogout} className="mt-6">
            <LogOut size={15} /> Sign out
          </Button>
        </Card>
        <Card className="p-6">
          <h2 className="font-semibold text-omp-ink">About this workspace</h2>
          <p className="mt-3 text-sm leading-6 text-omp-muted">
            OMP Builder is a self-hosted app studio powered exclusively by the OMP agent, behind the backend API. Provider
            credentials are encrypted on the server and never shown in the browser.
          </p>
          <p className="mt-3 text-sm leading-6 text-omp-muted">
            Provider settings live under <span className="font-medium text-omp-ink">AI Providers</span> in the sidebar. Phase 3
            adds the file editor and live preview containers; Phase 4 adds GitHub and deployment.
          </p>
        </Card>
      </div>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [screen, setScreen] = useState<NavScreen>("dashboard");
  const [selected, setSelected] = useState<Project>();
  const [showCreate, setShowCreate] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .authStatus()
      .then((status) => {
        setAuth(status);
        if (status.user) {
          Promise.all([api.projects(), api.providers()])
            .then(([projectResult, providerResult]) => {
              setProjects(projectResult.projects);
              setProviders(providerResult.providers);
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load workspace"));
        }
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not connect to API"));
  }, []);

  if (!auth) {
    return (
      <main className="grid h-[100dvh] place-items-center bg-omp-canvas px-5 text-sm text-omp-muted">
        {error || "Connecting to OMP Builder…"}
      </main>
    );
  }
  if (!auth.user) {
    return (
      <Auth
        status={auth}
        onAuthenticated={(user) => {
          setAuth({ setupRequired: false, user });
          Promise.all([api.projects(), api.providers()]).then(([projectResult, providerResult]) => {
            setProjects(projectResult.projects);
            setProviders(providerResult.providers);
          });
        }}
      />
    );
  }

  const logout = () => api.logout().then(() => setAuth({ setupRequired: false, user: null }));
  const open = (project: Project) => {
    setSelected(project);
    setScreen("builder");
  };
  const openBuilder = () => {
    const target = selected ?? [...projects].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    if (target) open(target);
    else setShowCreate(true);
  };
  const navigate = (next: NavScreen) => {
    if (next === "builder") {
      openBuilder();
      return;
    }
    setScreen(next);
    setSelected(undefined);
  };
  const created = (project: Project) => {
    setProjects((items) => [project, ...items]);
    setShowCreate(false);
    open(project);
  };

  const content =
    screen === "dashboard" ? (
      <Dashboard projects={projects} providers={providers} onOpen={open} onCreate={() => setShowCreate(true)} onViewAll={() => setScreen("projects")} />
    ) : screen === "projects" ? (
      <ProjectsList projects={projects} onOpen={open} onCreate={() => setShowCreate(true)} />
    ) : screen === "providers" ? (
      <Providers providers={providers} onProviders={setProviders} />
    ) : screen === "github" ? (
      <GitHubView onBack={() => setScreen("dashboard")} />
    ) : screen === "settings" ? (
      <SettingsView user={auth.user} projects={projects} providers={providers} onLogout={logout} />
    ) : selected ? (
      <Builder project={selected} onNavigate={navigate} />
    ) : (
      <Dashboard projects={projects} providers={providers} onOpen={open} onCreate={() => setShowCreate(true)} onViewAll={() => setScreen("projects")} />
    );

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-omp-canvas text-omp-ink md:flex-row">
      {screen !== "builder" && (
        <DesktopSidebar screen={screen} onNavigate={navigate} userEmail={auth.user.email} onLogout={logout} onManageModels={() => setScreen("providers")} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-omp-border bg-white px-4 py-3 md:hidden">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark size={32} />
            <span className="truncate text-sm font-bold">
              {screen === "builder" ? "Build Studio" : `omp. — ${screenTitles[screen]}`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-lg p-2 text-omp-muted hover:bg-omp-canvas"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
        </header>
        {error && (
          <div className="shrink-0 border-b border-[#f6c6c6] bg-[#fdecec] px-4 py-2 text-xs text-[#a83232]">{error}</div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{content}</div>
        <div className="h-[68px] shrink-0 md:hidden" />
        <MobileBottomNav screen={screen} onNavigate={navigate} />
      </div>
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        screen={screen}
        onNavigate={navigate}
        userEmail={auth.user.email}
        onLogout={logout}
        onManageModels={() => setScreen("providers")}
      />
      {showCreate && <NewProject providers={providers} onCancel={() => setShowCreate(false)} onCreated={created} />}
    </main>
  );
}
