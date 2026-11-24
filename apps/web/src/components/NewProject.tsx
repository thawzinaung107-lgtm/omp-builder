import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, GitBranch, LayoutTemplate, Paperclip, Sparkles, X } from "lucide-react";
import { parseGitHubRepoUrl, type GitHubImportResult, type Project, type Provider } from "@omp-builder/shared";
import { api } from "../api";
import { Button, Field, inputClass } from "../ui";

type Mode = "ai" | "template" | "git";

export function NewProject({
  providers,
  onCancel,
  onCreated,
}: {
  providers: Provider[];
  onCancel: () => void;
  onCreated: (project: Project) => void;
}) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<Mode>("ai");
  const [modeNote, setModeNote] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [importResult, setImportResult] = useState<GitHubImportResult | null>(null);
  const [importedProject, setImportedProject] = useState<Project | null>(null);
  const [modelId, setModelId] = useState(() => localStorage.getItem("omp-builder-default-provider") ?? providers[0]?.id ?? "");
  const [attachNote, setAttachNote] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedProvider = providers.find((p) => p.id === modelId) ?? providers[0];
  const chooseMode = (next: Mode) => {
    if (next === "template") {
      setModeNote("Templates arrive in a later milestone — Start with AI works now.");
      return;
    }
    setMode(next);
    setModeNote("");
  };
  const changeModel = (value: string) => {
    setModelId(value);
    if (value) localStorage.setItem("omp-builder-default-provider", value);
  };
  const continueToReview = () => {
    if (!name.trim()) return;
    if (mode === "git") {
      try {
        parseGitHubRepoUrl(repoUrl.trim());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Invalid repository URL");
        return;
      }
      setError("");
      setStep(2);
      return;
    }
    if (!prompt.trim()) return;
    setStep(2);
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "git") {
        const result = await api.importGitHubProject(name.trim(), repoUrl.trim());
        setImportedProject(result.project);
        setImportResult(result.import);
        return;
      }
      const result = await api.createProject(name.trim(), prompt.trim());
      onCreated(result.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  };

  const modeCard = (id: Mode, icon: React.ReactNode, title: string, body: string) => (
    <button
      key={id}
      type="button"
      onClick={() => chooseMode(id)}
      className={`flex items-start gap-3 rounded-omp-lg border p-4 text-left transition ${
        mode === id ? "border-omp-brand/60 bg-omp-brandSubtle/40" : "border-omp-border bg-white hover:border-omp-brand/40"
      }`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${mode === id ? "bg-omp-brand text-white" : "bg-omp-canvas text-omp-muted"}`}>{icon}</span>
      <span>
        <span className="flex items-center gap-2 text-sm font-semibold text-omp-ink">
          {title}
          {id === "template" && <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-omp-muted">Soon</span>}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-omp-muted">{body}</span>
      </span>
      {mode === id && <Check size={16} className="ml-auto shrink-0 text-omp-brand" />}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-omp-canvas">
      <div className="flex min-h-full flex-col lg:flex-row">
        {/* Left panel */}
        <aside className="shrink-0 bg-omp-nav px-6 py-6 text-white lg:flex lg:w-[380px] lg:flex-col lg:justify-between lg:p-10">
          <div>
            <button type="button" onClick={onCancel} className="mb-8 flex items-center gap-2 text-sm text-white/70 hover:text-white">
              <ArrowLeft size={15} /> Back to projects
            </button>
            <h2 className="text-3xl font-bold leading-tight tracking-tight">Bring your ideas to life.</h2>
            <p className="mt-3 text-sm leading-6 text-white/60">
              Describe the product. Choose a model. Build and iterate in one workspace.
            </p>
            <p className="mt-6 flex items-center gap-2 text-sm text-white/80">
              <Sparkles size={15} className="text-omp-brand" /> Powered by your configured OMP agent
            </p>
          </div>
          <div className="mt-10 hidden lg:block">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">Your build flow</div>
            <ol className="mt-4 space-y-4">
              {[
                ["01", "Create a project"],
                ["02", "Select a provider and model"],
                ["03", "Chat, preview and ship"],
              ].map(([num, label]) => (
                <li key={num} className="flex items-center gap-3 text-sm">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[.08] text-xs font-bold text-white/80">{num}</span>
                  <span className="text-white/85">{label}</span>
                </li>
              ))}
            </ol>
            <p className="mt-8 text-sm font-medium text-white/80">Your code. Your provider. Your workflow.</p>
          </div>
        </aside>

        {/* Right form */}
        <section className="flex min-w-0 flex-1 items-start justify-center px-5 py-8 lg:items-center lg:px-12">
          <div className="w-full max-w-2xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-omp-brand">Step {step} of 2</span>
              <button type="button" onClick={onCancel} className="rounded-lg p-2 text-omp-muted hover:bg-black/[.04] hover:text-omp-ink" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {step === 1 ? (
              <>
                <h1 className="text-2xl font-bold tracking-tight text-omp-ink">Create a new project</h1>
                <p className="mt-1.5 text-sm text-omp-muted">Start with a prompt, a template or an existing repository.</p>
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {modeCard("ai", <Sparkles size={17} />, "Start with AI", "Describe an idea and build it.")}
                  {modeCard("template", <LayoutTemplate size={17} />, "Use a template", "Kickstart a familiar layout.")}
                  {modeCard("git", <GitBranch size={17} />, "Import from Git", "Bring existing source code.")}
                </div>
                {modeNote && (
                  <div role="status" className="mt-3 rounded-omp border border-omp-border bg-white px-3.5 py-2.5 text-sm text-omp-muted">
                    {modeNote}
                  </div>
                )}
                <div className="mt-7 grid gap-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Project name">
                      <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="my-next-app" className={inputClass} />
                    </Field>
                    <Field label="Framework">
                      <select value="react-ts" onChange={() => undefined} className={inputClass} aria-label="Framework">
                        <option value="react-ts">React + TypeScript</option>
                      </select>
                    </Field>
                  </div>
                  {mode === "git" && (
                    <>
                      <Field label="GitHub repository URL">
                        <input
                          required
                          value={repoUrl}
                          onChange={(event) => setRepoUrl(event.target.value)}
                          placeholder="https://github.com/octocat/Hello-World"
                          className={inputClass}
                        />
                      </Field>
                      <div role="status" className="rounded-omp border border-omp-border bg-white px-3.5 py-2.5 text-sm leading-6 text-omp-muted">
                        Public repositories only — no sign-in, and never put a username, password or token in the URL. The import is a shallow
                        clone (latest commit only); repositories over 500 MB are refused. Secret files (.env, *.pem, *.key) are removed from the
                        workspace, and any AGENTS.md, CLAUDE.md or .omp/RULES.md in the repo is listed after import — the AI will honor those
                        files on its next turn, so review them.
                      </div>
                    </>
                  )}
                  {mode !== "git" && (
                    <>
                  <Field label="What would you like to build?">
                    <textarea
                      required
                      minLength={1}
                      maxLength={20000}
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      rows={5}
                      placeholder="A modern booking dashboard with customer management, beautiful charts and a clean, responsive layout..."
                      className="w-full resize-none rounded-omp border border-omp-border bg-white px-3.5 py-2.5 text-sm text-omp-ink outline-none transition placeholder:text-omp-muted/70 focus:border-omp-brand focus:ring-2 focus:ring-omp-brand/15"
                    />
                  </Field>
                  <button
                    type="button"
                    onClick={() => setAttachNote((v) => !v)}
                    className="flex w-fit items-center gap-2 text-sm font-medium text-omp-brand hover:underline"
                  >
                    <Paperclip size={15} /> Attach files +
                  </button>
                  {attachNote && (
                    <div role="status" className="rounded-omp border border-omp-border bg-white px-3.5 py-2.5 text-sm text-omp-muted">
                      File attachments aren't supported yet — describe the files in your prompt instead.
                    </div>
                  )}
                    </>
                  )}
                  <div className="rounded-omp border border-omp-border bg-white p-4">
                    <div className="mb-2 text-sm font-medium text-omp-ink">AI provider &amp; model</div>
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        value={modelId}
                        onChange={(event) => changeModel(event.target.value)}
                        disabled={!providers.length}
                        className="min-w-0 flex-1 rounded-omp border border-omp-border bg-white px-3 py-2 text-sm text-omp-ink outline-none focus:border-omp-brand"
                        aria-label="AI provider and model"
                      >
                        {providers.length === 0 && <option value="">No providers configured</option>}
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.displayName} • {provider.modelId}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-omp-muted">
                        {selectedProvider ? `Browser default • ${selectedProvider.displayName}` : "Configure a provider first"}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-omp-muted">You can change the model later within the project.</p>
                  </div>
                  {error && (
                    <div role="alert" className="rounded-omp border border-[#f6c6c6] bg-[#fdecec] px-3.5 py-2.5 text-sm text-[#a83232]">
                      {error}
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                      Cancel
                    </Button>
                    <Button onClick={continueToReview} disabled={!name.trim() || (mode === "git" ? !repoUrl.trim() : !prompt.trim())}>
                      Continue <ArrowRight size={15} />
                    </Button>
                  </div>
                </div>
              </>
            ) : importResult && importedProject ? (
              <>
                <h1 className="text-2xl font-bold tracking-tight text-omp-ink">Import complete</h1>
                <p className="mt-1.5 text-sm text-omp-muted">
                  {importResult.owner}/{importResult.repo} imported — {importResult.filesImported} files from commit {importResult.headOid.slice(0, 7)}.
                  Shallow clone: latest commit only, history preserved.
                </p>
                <div className="mt-6 grid gap-4 rounded-omp-lg border border-omp-border bg-white p-5">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Repository</div>
                    <div className="mt-1 text-sm text-omp-ink">{importResult.sourceUrl}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Size</div>
                    <div className="mt-1 text-sm text-omp-ink">
                      {(importResult.sizeBytes / 1024 / 1024).toFixed(2)} MB of {(importResult.sizeLimitBytes / 1024 / 1024).toFixed(0)} MB limit
                    </div>
                  </div>
                  {importResult.excludedSecrets.length > 0 && (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Secret files removed</div>
                      <ul className="mt-1 list-disc pl-5">
                        {importResult.excludedSecrets.map((file) => (
                          <li key={file} className="font-mono text-xs leading-5 text-omp-ink">{file}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-xs leading-5 text-omp-muted">
                        These may still exist in the preserved git history — rotate any exposed secret.
                      </p>
                    </div>
                  )}
                  {importResult.rulesFiles.length > 0 ? (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">AI rules found — review before your first turn</div>
                      <ul className="mt-1 list-disc pl-5">
                        {importResult.rulesFiles.map((file) => (
                          <li key={file.path} className="font-mono text-xs leading-5 text-omp-ink">{file.path}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-xs leading-5 text-omp-muted">
                        The AI loads these files on its next turn. Check AGENTS.md / CLAUDE.md in the file explorer and .omp/RULES.md in the
                        Rules tab before prompting.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">AI rules found</div>
                      <p className="mt-1 text-sm text-omp-ink">None — no AGENTS.md, CLAUDE.md or .omp/RULES.md at the repository root.</p>
                    </div>
                  )}
                </div>
                <div className="mt-6 flex justify-end gap-2">
                  <Button onClick={() => onCreated(importedProject)}>
                    Open project <ArrowRight size={15} />
                  </Button>
                </div>
              </>
            ) : (
              <form onSubmit={start}>
                <h1 className="text-2xl font-bold tracking-tight text-omp-ink">Review and start building</h1>
                {mode === "git" ? (
                  <p className="mt-1.5 text-sm text-omp-muted">A shallow clone of the public repository — no credentials are sent or stored.</p>
                ) : (
                  <p className="mt-1.5 text-sm text-omp-muted">The prompt becomes the first OMP session instruction.</p>
                )}
                <div className="mt-6 grid gap-4 rounded-omp-lg border border-omp-border bg-white p-5">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Project</div>
                    <div className="mt-1 font-semibold text-omp-ink">{name}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Framework</div>
                    <div className="mt-1 text-sm text-omp-ink">React + TypeScript</div>
                  </div>
                  {mode === "git" ? (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Repository</div>
                      <div className="mt-1 text-sm text-omp-ink">{repoUrl.trim()}</div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Prompt</div>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-omp-ink">{prompt}</p>
                    </div>
                  )}
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-omp-muted">Model</div>
                    <div className="mt-1 text-sm text-omp-ink">
                      {selectedProvider ? `${selectedProvider.displayName} • ${selectedProvider.modelId}` : "No provider configured"}
                    </div>
                  </div>
                </div>
                {error && (
                  <div role="alert" className="mt-4 rounded-omp border border-[#f6c6c6] bg-[#fdecec] px-3.5 py-2.5 text-sm text-[#a83232]">
                    {error}
                  </div>
                )}
                <div className="mt-6 flex justify-between gap-2">
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    <ArrowLeft size={15} /> Back
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? (mode === "git" ? "Importing…" : "Creating…") : mode === "git" ? "Import repository" : "Start building"} <Sparkles size={15} />
                  </Button>
                </div>
              </form>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
