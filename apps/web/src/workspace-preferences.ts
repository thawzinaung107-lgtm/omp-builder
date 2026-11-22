const workspaceTabs = ["preview", "code", "files", "logs", "git"] as const;
export const mobileTabs = ["chat", "preview", "code", "files"] as const;
const previewDevices = ["desktop", "mobile"] as const;

export type WorkspaceTab = (typeof workspaceTabs)[number];

export type WorkspacePreferences = {
  tab: WorkspaceTab;
  mobileTab: (typeof mobileTabs)[number];
  device: (typeof previewDevices)[number];
  split: boolean;
};

const defaults: WorkspacePreferences = {
  tab: "preview",
  mobileTab: "chat",
  device: "desktop",
  split: false,
};

const version = 1;

export function workspacePreferencesKey(adminId: string, projectId: string): string {
  return `omp-builder:workspace-preferences:v${version}:${encodeURIComponent(adminId)}:${encodeURIComponent(projectId)}`;
}

function choice<T extends string>(choices: readonly T[], value: unknown, fallback: T): T {
  return choices.find((entry) => entry === value) ?? fallback;
}

function normalize(value: Record<string, unknown>): WorkspacePreferences {
  return {
    tab: choice(workspaceTabs, value.tab, defaults.tab),
    mobileTab: choice(mobileTabs, value.mobileTab, defaults.mobileTab),
    device: choice(previewDevices, value.device, defaults.device),
    split: typeof value.split === "boolean" ? value.split : defaults.split,
  };
}

export function loadWorkspacePreferences(key: string): WorkspacePreferences {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value) && value.version === version) {
      return normalize(value);
    }
  } catch {
    // Storage may be disabled or contain invalid JSON.
  }
  return { ...defaults };
}

export function saveWorkspacePreferences(key: string, preferences: WorkspacePreferences): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ version, ...normalize(preferences) }));
  } catch {
    // Keep the workspace usable when storage is unavailable or full.
  }
}
