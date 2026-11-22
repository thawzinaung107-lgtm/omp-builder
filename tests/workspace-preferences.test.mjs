import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  loadWorkspacePreferences,
  saveWorkspacePreferences,
  workspacePreferencesKey,
} from "../apps/web/src/workspace-preferences.ts";

const defaults = { tab: "preview", mobileTab: "chat", device: "desktop", split: false };
const changed = { tab: "logs", mobileTab: "files", device: "mobile", split: true };
const key = workspacePreferencesKey("admin-1", "project-1");
let entries;

beforeEach(() => {
  entries = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (name) => entries.get(name) ?? null,
      setItem: (name, value) => entries.set(name, value),
    },
  };
});

afterEach(() => {
  delete globalThis.window;
});

test("round trips supported preferences, isolated by admin and project", () => {
  const otherProject = workspacePreferencesKey("admin-1", "project-2");
  const otherAdmin = workspacePreferencesKey("admin-2", "project-1");
  assert.deepEqual(loadWorkspacePreferences(key), defaults);
  saveWorkspacePreferences(key, changed);
  saveWorkspacePreferences(otherProject, { ...defaults, tab: "code" });
  assert.deepEqual(loadWorkspacePreferences(key), changed);
  assert.deepEqual(loadWorkspacePreferences(otherProject), { ...defaults, tab: "code" });
  assert.deepEqual(loadWorkspacePreferences(otherAdmin), defaults);
  assert.notEqual(workspacePreferencesKey("a:b", "c"), workspacePreferencesKey("a", "b:c"));
});

test("recovers from corrupt JSON, invalid records, and unknown versions", () => {
  for (const raw of ["{", "null", "[]", "false", '{"version":2,"tab":"logs"}']) {
    entries.set(key, raw);
    assert.deepEqual(loadWorkspacePreferences(key), defaults);
  }
  entries.set(key, '{"version":1,"tab":"logs","mobileTab":"git","device":4,"split":"true"}');
  assert.deepEqual(loadWorkspacePreferences(key), { ...defaults, tab: "logs" });
});

test("stores only the supported UI fields even when extra data is passed", () => {
  saveWorkspacePreferences(key, { ...changed, apiKey: "private", code: "source", chat: "draft", token: "secret" });
  assert.deepEqual(JSON.parse(entries.get(key)), { version: 1, ...changed });
});

test("storage access or write failures do not prevent using the workspace", () => {
  globalThis.window.localStorage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.doesNotThrow(() => saveWorkspacePreferences(key, changed));
  Object.defineProperty(globalThis.window, "localStorage", {
    get() { throw new Error("Access denied"); },
  });
  assert.deepEqual(loadWorkspacePreferences(key), defaults);
  assert.doesNotThrow(() => saveWorkspacePreferences(key, changed));
});
