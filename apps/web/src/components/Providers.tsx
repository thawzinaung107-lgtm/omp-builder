import { useState, type FormEvent } from "react";
import { ArrowLeft, Check, ChevronRight, Plus, Server, ShieldCheck, X } from "lucide-react";
import type { Provider } from "@omp-builder/shared";
import { api } from "../api";
import { Button, Card, Field, StatusChip, Toggle, inputClass } from "../ui";

type ProviderDraft = { providerId: string; displayName: string; baseUrl: string; api: Provider["api"]; modelId: string; apiKey: string };
const emptyProviderDraft = (): ProviderDraft => ({ providerId: "", displayName: "", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "", apiKey: "" });

type Health = "healthy" | "untested" | "error";
const healthChip = (health: Health) =>
  health === "healthy" ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-omp-success">
      <span className="h-2 w-2 rounded-full bg-omp-success" /> Healthy
    </span>
  ) : health === "error" ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-[#c73e3e]">
      <span className="h-2 w-2 rounded-full bg-[#e85b61]" /> Error
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs font-medium text-omp-muted">
      <span className="h-2 w-2 rounded-full bg-[#a2aabe]" /> Not tested
    </span>
  );

export function Providers({ providers, onProviders }: { providers: Provider[]; onProviders: (providers: Provider[]) => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const [editingId, setEditingId] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testedOk, setTestedOk] = useState(false);
  const [defaultId, setDefaultId] = useState(() => localStorage.getItem("omp-builder-default-provider") ?? "");
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [mobileDetail, setMobileDetail] = useState(false);
  const [helpNote, setHelpNote] = useState(false);

  const editing = providers.find((provider) => provider.id === editingId);
  const update = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const refresh = async () => {
    const result = await api.providers();
    onProviders(result.providers);
  };
  const selectProvider = (provider?: Provider) => {
    setEditingId(provider?.id);
    setDraft(
      provider
        ? { providerId: provider.providerId, displayName: provider.displayName, baseUrl: provider.baseUrl, api: provider.api, modelId: provider.modelId, apiKey: "" }
        : emptyProviderDraft(),
    );
    setError("");
    setNotice("");
    setTestedOk(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = { ...draft, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) };
      const result = editing
        ? await api.updateProvider(editing.id, payload)
        : await api.createProvider({ ...payload, apiKey: draft.apiKey });
      await refresh();
      setEditingId(result.provider.id);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setNotice(editing ? "Provider updated. The stored key remains masked." : "Provider added. The credential is encrypted on the server.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save provider");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError("");
    setNotice("");
    setTestedOk(false);
    try {
      const result = await api.testProvider({ baseUrl: draft.baseUrl, apiKey: draft.apiKey || undefined });
      if (!result.ok) throw new Error(result.error ?? "Provider rejected the connection");
      setTestedOk(true);
      setNotice("Connection successful. Endpoint responded. Credentials remain masked.");
      if (editingId) setHealth((current) => ({ ...current, [editingId]: "healthy" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider connectivity test failed");
      if (editingId) setHealth((current) => ({ ...current, [editingId]: "error" }));
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    if (!editing || !window.confirm(`Delete ${editing.displayName}?`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteProvider(editing.id);
      onProviders(providers.filter((provider) => provider.id !== editing.id));
      if (defaultId === editing.id) {
        localStorage.removeItem("omp-builder-default-provider");
        setDefaultId("");
      }
      selectProvider();
      setNotice("Provider deleted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete provider");
    } finally {
      setBusy(false);
    }
  };
  const makeDefault = (id: string) => {
    setDefaultId(id);
    if (id) localStorage.setItem("omp-builder-default-provider", id);
    else localStorage.removeItem("omp-builder-default-provider");
    setNotice("Default model updated for this browser.");
  };

  const form = (
    <form onSubmit={save} className="grid gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-omp-ink">{editing ? editing.displayName : "New provider"}</h2>
          <p className="mt-0.5 text-xs text-omp-muted">
            {editing ? "Manage your OpenAI-compatible connection" : "Connect an OpenAI-compatible service."}
          </p>
        </div>
        {editing?.hasApiKey && <StatusChip label="Connected" tone="success" />}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Display name">
          <input required value={draft.displayName} onChange={(event) => update("displayName", event.target.value)} placeholder="Primary Cloud" className={inputClass} />
        </Field>
        <Field label="Provider ID">
          <input required value={draft.providerId} onChange={(event) => update("providerId", event.target.value)} placeholder="openai" className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Base URL" hint="HTTPS endpoint">
          <input required type="url" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" className={inputClass} />
        </Field>
        <Field label="API key" hint="A new key replaces the saved key.">
          <input
            type="password"
            autoComplete="new-password"
            required={!editing}
            value={draft.apiKey}
            onChange={(event) => update("apiKey", event.target.value)}
            placeholder={editing ? "sk-••••••••••••••••" : "Enter credential"}
            className={inputClass}
          />
        </Field>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="API mode">
          <select value={draft.api} onChange={(event) => update("api", event.target.value as Provider["api"])} className={inputClass}>
            <option value="openai-responses">Responses API</option>
            <option value="openai-completions">Completions API</option>
          </select>
        </Field>
        <Field label="Default model ID">
          <input required value={draft.modelId} onChange={(event) => update("modelId", event.target.value)} placeholder="gpt-4o-mini" className={inputClass} />
        </Field>
      </div>
      {editing && (
        <div>
          <div className="mb-2 text-sm font-medium text-omp-ink">Available model IDs</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-omp-brandSubtle px-3 py-1.5 text-xs font-medium text-omp-brand">
              {editing.providerId}/{editing.modelId}
            </span>
            <span className="text-xs text-omp-muted">Additional model IDs arrive with multi-model providers.</span>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-4 rounded-omp border border-omp-border bg-omp-canvas p-4">
        <div>
          <div className="text-sm font-medium text-omp-ink">Default model for new projects</div>
          <p className="mt-0.5 text-xs leading-5 text-omp-muted">
            Saved as a browser-local preference. Active projects can select a different provider/model.
          </p>
        </div>
        <Toggle checked={editingId ? defaultId === editingId : false} onChange={(value) => editingId && makeDefault(value ? editingId : "")} label="Default model for new projects" />
      </div>
      {testedOk && (
        <div role="status" className="flex items-start gap-2.5 rounded-omp border border-[#bfe6d8] bg-[#e3f7f0] px-3.5 py-3 text-sm text-omp-success">
          <Check size={16} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">Connection successful</span>
            <br />
            Endpoint responded. Credentials remain masked.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-omp border border-[#f6c6c6] bg-[#fdecec] px-3.5 py-2.5 text-sm text-[#a83232]">
          {error}
        </div>
      )}
      {notice && !testedOk && (
        <div role="status" className="rounded-omp border border-[#bfe6d8] bg-[#e3f7f0] px-3.5 py-2.5 text-sm text-omp-success">
          {notice}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={test} disabled={testing || !draft.baseUrl}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add provider"}
        </Button>
        {editing && (
          <Button variant="danger" onClick={remove} disabled={busy} className="ml-auto">
            Delete provider
          </Button>
        )}
      </div>
    </form>
  );

  const list = (
    <div className="space-y-3">
      {providers.length === 0 && (
        <Card className="grid place-items-center p-6 text-center">
          <div>
            <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-omp-brandSubtle text-omp-brand">
              <Server size={20} />
            </div>
            <h3 className="font-semibold text-omp-ink">Add your first provider</h3>
            <p className="mt-1 text-sm leading-6 text-omp-muted">Provider keys never return in API responses and are never shown after submission.</p>
          </div>
        </Card>
      )}
      {providers.map((provider) => {
        const selected = editingId === provider.id;
        const providerHealth: Health = health[provider.id] ?? "untested";
        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => {
              selectProvider(provider);
              setMobileDetail(true);
            }}
            className={`w-full rounded-omp-lg border bg-white p-4 text-left transition ${
              selected ? "border-omp-brand/60 bg-omp-brandSubtle/40 shadow-sm" : "border-omp-border hover:border-omp-brand/40"
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-omp-brandSubtle text-base font-bold text-omp-brand">◈</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-omp-ink">{provider.displayName}</span>
                  {defaultId === provider.id && <StatusChip label="Default" tone="brand" />}
                </span>
                <span className="mt-0.5 block truncate text-xs text-omp-muted">
                  {provider.baseUrl.startsWith("http://") ? "Local HTTP" : "OpenAI-compatible"} • {provider.api === "openai-responses" ? "Responses" : "Completions"} API • 1 model
                </span>
                <span className="mt-2 block">{healthChip(providerHealth)}</span>
              </span>
              <ChevronRight size={16} className="mt-1 shrink-0 text-omp-muted md:hidden" />
            </div>
          </button>
        );
      })}
      <Card className="flex items-start gap-2.5 bg-omp-canvas p-4">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-omp-success" />
        <p className="text-xs leading-5 text-omp-muted">
          <span className="font-semibold text-omp-ink">Your keys stay private</span>
          <br />
          Existing API keys are never shown. Saved credentials are cleared from the form.
        </p>
      </Card>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 pb-24 pt-6 md:px-10 md:pb-10 md:pt-8">
      {/* Desktop header */}
      <div className="mb-6 hidden items-center justify-between gap-4 md:flex">
        <div className="text-sm text-omp-muted">
          Settings <span className="mx-1 text-omp-border">/</span> <span className="font-medium text-omp-ink">AI Providers</span>
        </div>
        <button type="button" onClick={() => setHelpNote((v) => !v)} className="text-sm font-medium text-omp-brand hover:underline">
          Help & documentation ↗
        </button>
      </div>
      {helpNote && (
        <div className="mb-5 rounded-omp border border-omp-border bg-white px-4 py-3 text-sm leading-6 text-omp-muted md:hidden">
          Provider setup docs live in the repository under <span className="font-mono text-xs">docs/</span>. Keys are encrypted on the server and never shown again.
        </div>
      )}

      {/* Mobile header */}
      <div className="mb-5 md:hidden">
        {mobileDetail ? (
          <button type="button" onClick={() => setMobileDetail(false)} className="mb-3 flex items-center gap-1.5 text-sm font-medium text-omp-brand">
            <ArrowLeft size={15} /> All providers
          </button>
        ) : (
          <>
            <h1 className="text-xl font-bold tracking-tight text-omp-ink">AI Providers</h1>
            <p className="mt-1 text-sm text-omp-muted">Manage endpoints and available models.</p>
          </>
        )}
      </div>

      {/* Desktop title */}
      <div className="mb-7 hidden items-start justify-between gap-4 md:flex">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-omp-ink">AI Provider Management</h1>
          <p className="mt-1.5 text-sm text-omp-muted">Connect models, test endpoints and choose your defaults.</p>
        </div>
        <Button
          onClick={() => {
            selectProvider();
            setMobileDetail(true);
          }}
        >
          <Plus size={16} /> Add provider
        </Button>
      </div>

      {/* Mobile: list or detail */}
      <div className="md:hidden">
        {mobileDetail ? (
          <Card className="p-5">
            {form}
            <button type="button" onClick={() => setMobileDetail(false)} className="mt-4 flex items-center gap-1.5 text-sm font-medium text-omp-brand">
              <X size={15} /> Close
            </button>
          </Card>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-omp-ink">Your connections</h2>
              <Button
                variant="outline"
                className="!px-3 !py-2 !text-xs"
                onClick={() => {
                  selectProvider();
                  setMobileDetail(true);
                }}
              >
                <Plus size={14} /> Add provider
              </Button>
            </div>
            {list}
            <div className="mt-5 space-y-2 text-xs leading-5 text-omp-muted">
              <p className="flex items-start gap-2">
                <Check size={14} className="mt-0.5 shrink-0 text-omp-success" /> API keys never appear in provider listings
              </p>
              <p className="flex items-start gap-2">
                <Check size={14} className="mt-0.5 shrink-0 text-omp-success" /> HTTPS endpoints required (except localhost)
              </p>
            </div>
          </>
        )}
      </div>

      {/* Desktop: list + form */}
      <div className="hidden gap-6 md:grid lg:grid-cols-[380px_minmax(0,1fr)]">
        <div>
          <h2 className="mb-1 text-base font-bold text-omp-ink">Connected providers</h2>
          <p className="mb-4 text-sm text-omp-muted">Choose which model powers each project.</p>
          {list}
        </div>
        <Card className="h-fit p-6">{form}</Card>
      </div>
    </div>
  );
}
