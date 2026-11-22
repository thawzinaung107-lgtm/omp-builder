import { Code2, Folder, GitBranch, LayoutDashboard, LogOut, Server, Settings2, X } from "lucide-react";
import { BrandMark, Button } from "../ui";

export type NavScreen = "dashboard" | "projects" | "builder" | "providers" | "github" | "settings";

const navSections: { label: string; items: { id: NavScreen; label: string; icon: typeof LayoutDashboard }[] }[] = [
  {
    label: "Workspace",
    items: [
      { id: "dashboard", label: "Overview", icon: LayoutDashboard },
      { id: "projects", label: "My Projects", icon: Folder },
      { id: "builder", label: "Build Studio", icon: Code2 },
    ],
  },
  {
    label: "Settings",
    items: [
      { id: "providers", label: "AI Providers", icon: Server },
      { id: "github", label: "GitHub", icon: GitBranch },
      { id: "settings", label: "Settings", icon: Settings2 },
    ],
  },
];

function NavContent({ screen, onNavigate, userEmail, onLogout, onManageModels }: SidebarProps) {
  return (
    <div className="flex h-full flex-col bg-omp-nav text-white">
      <div className="flex items-center gap-3 px-5 pb-2 pt-6">
        <BrandMark size={36} />
        <div className="leading-none">
          <div className="text-[22px] font-bold tracking-tight">omp.</div>
          <div className="mt-1 text-[9px] font-medium tracking-[0.18em] text-white/50">AI APP BUILDER</div>
        </div>
      </div>

      <nav className="mt-8 flex-1 space-y-7 overflow-y-auto px-4">
        {navSections.map((section) => (
          <div key={section.label}>
            <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">{section.label}</div>
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = screen === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    className={`flex w-full items-center gap-3 rounded-omp px-3 py-2.5 text-sm transition ${
                      active ? "bg-white/10 font-medium text-white" : "text-[#a2aabe] hover:bg-white/[.05] hover:text-white"
                    }`}
                  >
                    <Icon size={17} className={active ? "text-white" : ""} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-4 px-4 pb-5 pt-2">
        <div className="rounded-omp-lg bg-[#242a43] p-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Your workspace</div>
          <div className="mt-2 text-sm font-semibold">Build without limits</div>
          <p className="mt-1 text-xs leading-5 text-white/60">Add providers to power your agent.</p>
          <Button variant="subtle" className="mt-3 w-full !bg-white/[.12] !text-white hover:!bg-white/[.2]" onClick={onManageModels}>
            Manage models
          </Button>
        </div>
        <div className="flex items-center gap-3 px-1">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-omp-brand text-sm font-bold text-white">
            {userEmail ? userEmail[0].toUpperCase() : "A"}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">Admin workspace</div>
            <div className="truncate text-xs text-white/50">Owner</div>
          </div>
          <button type="button" onClick={onLogout} className="rounded-lg p-2 text-white/50 hover:bg-white/[.06] hover:text-white" aria-label="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

type SidebarProps = {
  screen: NavScreen;
  onNavigate: (screen: NavScreen) => void;
  userEmail: string;
  onLogout: () => void;
  onManageModels: () => void;
};

export function DesktopSidebar(props: SidebarProps) {
  return (
    <aside className="hidden w-[242px] shrink-0 md:block">
      <NavContent {...props} />
    </aside>
  );
}

export function MobileDrawer({ open, onClose, ...props }: SidebarProps & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] shadow-2xl">
        <NavContent {...props} onNavigate={(screen) => { props.onNavigate(screen); onClose(); }} />
        <button type="button" onClick={onClose} className="absolute right-3 top-4 rounded-lg bg-white/10 p-2 text-white" aria-label="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

const bottomItems: { id: NavScreen; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Home", icon: LayoutDashboard },
  { id: "builder", label: "Build", icon: Code2 },
  { id: "providers", label: "Models", icon: Server },
  { id: "settings", label: "Settings", icon: Settings2 },
];

export function MobileBottomNav({ screen, onNavigate }: { screen: NavScreen; onNavigate: (screen: NavScreen) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-omp-border bg-white px-2 pb-[env(safe-area-inset-bottom)] pt-1 md:hidden">
      {bottomItems.map((item) => {
        const active = screen === item.id;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={`flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-medium transition ${
              active ? "text-omp-brand" : "text-omp-muted"
            }`}
          >
            <Icon size={20} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
