/**
 * OMP Builder preview element picker (Milestone E, B3).
 *
 * Static client script, injected by the preview gateway (inlined after
 * `<head>`) ONLY when picker mode is on for the project — see
 * `apps/api/src/picker.ts` (SHA-256 hash-pinned, zero secrets) and the
 * security review `PICKER-SECURITY-REVIEW.md`.
 *
 * What it does: hover outlines, click-to-pick, persistent overlays for
 * picked elements, and `postMessage` of DOM-only selections
 * (`omp-component-selected` / `omp-component-deselected`) to the Builder
 * parent. That is all it does: no credentials, no identifiers, no file
 * paths or line numbers (B4 v1 is DOM-only — there is no build-time
 * tagger, so a clicked element has no known source location), no
 * coordinate stream, no shortcut forwarding, no nested-iframe bubbling,
 * no direct style edits.
 *
 * Security posture (read the review — this script runs in the SAME
 * JavaScript realm as the untrusted previewed app, so app code can
 * tamper with it, blind it, or post indistinguishable fake selections):
 * the picker is a UX convenience, never a security boundary. Every
 * selection is untrusted input; the Builder validates it strictly,
 * shows it as labelled untrusted text, and only sends it to OMP as
 * quoted prompt context when the admin explicitly sends a prompt.
 *
 * Defence in depth inside the script (raises the bar for casual
 * interference; cannot prevent same-realm tampering): IIFE with no
 * globals, DOM built-ins snapshotted at the top, capture-phase
 * listeners, `textContent`-only overlay labels, `__omp_picker__`
 * namespaced classes, `pointer-events:none` overlays. The script is
 * inert until it receives an explicit `omp-picker-activate` command
 * from the Builder parent, and it ignores every message whose source
 * is not `window.parent`.
 *
 * Structure (hover outline, click-to-pick, persistent overlays) is
 * informed by Dyad's component selector client
 * (`worker/dyad-component-selector-client.js`, Apache-2.0 — see
 * docs/IMPLEMENTATION_PLAN.md §2); this file is OMP Builder's own
 * implementation, written for the DOM-only B4 shape: no `data-dyad-id`
 * lookup, no Pro-mode highlighting, no toolbar, no coordinate updates,
 * no reload/shortcut forwarding.
 */
(() => {
  "use strict";

  // Snapshot the built-ins this script needs, at the top, before app
  // code (which may run after injection) can patch them. This does not
  // guarantee first execution — an app inline script in <head> before
  // the injection point may already have run (review R-09) — but it
  // protects against later patching.
  var _addEventListener = EventTarget.prototype.addEventListener;
  var _removeEventListener = EventTarget.prototype.removeEventListener;
  var _getBoundingClientRect = Element.prototype.getBoundingClientRect;
  var _createElement = Document.prototype.createElement;
  var _querySelector = Element.prototype.querySelector;

  var OVERLAY_CLASS = "__omp_picker__overlay";
  var HOVER_CLASS = "__omp_picker__hover";
  var ACTIVE_BORDER = "#7158ef";
  var ACTIVE_FILL = "rgba(113, 88, 239, 0.06)";
  var HOVER_BORDER = "#7158ef";
  var HOVER_FILL = "rgba(113, 88, 239, 0.08)";
  var MAX_TEXT_CHARS = 200;
  var MAX_CLASS_CHARS = 200;
  var MAX_ID_CHARS = 128;

  // state: "inactive" | "inspecting". The script installs no click or
  // mouse interception and posts no message while inactive.
  var state = "inactive";
  var hoveredElement = null;
  var hoverOverlay = null;
  var hoverLabel = null;
  // Selected elements: [{ el, overlay, label }]. Overlays persist
  // while the picker is on; deactivation hides only the hover overlay.
  var selected = [];

  function style(el, styles) {
    for (var key in styles) {
      el.style[key] = styles[key];
    }
  }

  function makeOverlay(isHover) {
    var overlay = _createElement.call(document, "div");
    overlay.className = isHover ? HOVER_CLASS : OVERLAY_CLASS;
    style(overlay, {
      position: "absolute",
      border: "2px solid " + ACTIVE_BORDER,
      background: ACTIVE_FILL,
      pointerEvents: "none",
      zIndex: "2147483647",
      borderRadius: "4px",
      boxSizing: "border-box",
      display: "none",
    });
    var label = _createElement.call(document, "div");
    style(label, {
      position: "absolute",
      left: "0",
      top: "100%",
      transform: "translateY(4px)",
      background: ACTIVE_BORDER,
      color: "#fff",
      fontFamily: "monospace",
      fontSize: "12px",
      lineHeight: "1.2",
      padding: "3px 5px",
      whiteSpace: "nowrap",
      borderRadius: "4px",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.1)",
      pointerEvents: "none",
    });
    overlay.appendChild(label);
    document.body.appendChild(overlay);
    return { overlay: overlay, label: label };
  }

  function place(node, el) {
    var rect = _getBoundingClientRect.call(el);
    style(node, {
      top: rect.top + window.scrollY + "px",
      left: rect.left + window.scrollX + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      display: "block",
    });
  }

  function repositionAll() {
    for (var i = 0; i < selected.length; i += 1) {
      place(selected[i].overlay, selected[i].el);
    }
    if (hoverOverlay && hoverOverlay.style.display !== "none" && hoveredElement) {
      place(hoverOverlay, hoveredElement);
    }
  }

  function hideHover() {
    hoveredElement = null;
    if (hoverOverlay) hoverOverlay.style.display = "none";
  }

  function clearOverlays() {
    for (var i = 0; i < selected.length; i += 1) {
      selected[i].overlay.remove();
    }
    selected = [];
    if (hoverOverlay) {
      hoverOverlay.remove();
      hoverOverlay = null;
      hoverLabel = null;
    }
    hoveredElement = null;
  }

  // --- selection data (DOM-only) ---------------------------------------
  //
  // Never collect input/textarea/select values, password fields,
  // contenteditable content, or full subtree text. The snippet is the
  // element's own visible text, truncated to 200 chars; when the
  // element is (or contains) a form field, no text is collected at all
  // (a textarea's default value lives in its textContent).
  function hasFormField(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    try {
      return !!_querySelector.call(el, "input, textarea, select, [contenteditable]");
    } catch (e) {
      return false;
    }
  }

  function textSnippet(el) {
    if (hasFormField(el)) return undefined;
    var raw = el.textContent || "";
    var collapsed = raw.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    return collapsed.slice(0, MAX_TEXT_CHARS);
  }

  function describe(el) {
    var component = { tagName: el.tagName };
    var text = textSnippet(el);
    if (text !== undefined) component.text = text;
    var cls = el.getAttribute ? el.getAttribute("class") : null;
    if (typeof cls === "string" && cls) {
      var trimmedClass = cls.replace(/\s+/g, " ").trim().slice(0, MAX_CLASS_CHARS);
      if (trimmedClass) component.cssClass = trimmedClass;
    }
    if (typeof el.id === "string" && el.id) {
      component.elementId = el.id.slice(0, MAX_ID_CHARS);
    }
    return component;
  }

  function rectOf(el) {
    var rect = _getBoundingClientRect.call(el);
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }

  function post(type, component, el) {
    var message = { type: type, component: component };
    if (el) message.rect = rectOf(el);
    window.parent.postMessage(message, "*");
  }

  function isSelected(el) {
    for (var i = 0; i < selected.length; i += 1) {
      if (selected[i].el === el) return selected[i];
    }
    return null;
  }

  function select(el) {
    var made = makeOverlay(false);
    place(made.overlay, el);
    // Label: tag + text snippet, textContent only (never innerHTML).
    var label = describe(el);
    var labelText = "<" + label.tagName.toLowerCase() + ">";
    if (label.text) labelText += ' "' + label.text + '"';
    made.label.textContent = labelText;
    selected.push({ el: el, overlay: made.overlay, label: made.label });
    post("omp-component-selected", label, el);
  }

  function deselect(item) {
    item.overlay.remove();
    for (var i = 0; i < selected.length; i += 1) {
      if (selected[i] === item) {
        selected.splice(i, 1);
        break;
      }
    }
    post("omp-component-deselected", describe(item.el), null);
  }

  // --- event handlers (capture phase; installed only while active) -----
  function onMouseMove(e) {
    if (state !== "inspecting") return;
    var el = e.target;
    if (!el || el.nodeType !== 1) {
      hideHover();
      return;
    }
    // Overlays are pointer-events:none, so they are never the target.
    if (el === hoveredElement) return;
    hoveredElement = el;
    if (!document.body) return;
    if (!hoverOverlay || !hoverLabel) {
      var made = makeOverlay(true);
      hoverOverlay = made.overlay;
      hoverLabel = made.label;
    }
    place(hoverOverlay, el);
    var label = describe(el);
    var labelText = "<" + label.tagName.toLowerCase() + ">";
    if (label.text) labelText += ' "' + label.text + '"';
    hoverLabel.textContent = labelText;
  }

  function onMouseLeave(e) {
    if (!e.relatedTarget) hideHover();
  }

  function onClick(e) {
    if (state !== "inspecting" || !hoveredElement) return;
    e.preventDefault();
    e.stopPropagation();
    var el = hoveredElement;
    var existing = isSelected(el);
    if (existing) {
      deselect(existing);
      return;
    }
    select(el);
  }

  function onScrollOrResize() {
    if (state === "inactive" && selected.length === 0) return;
    repositionAll();
  }

  // --- activation --------------------------------------------------------
  function activate() {
    if (state === "inspecting") return;
    state = "inspecting";
    _addEventListener.call(window, "mousemove", onMouseMove, true);
    _addEventListener.call(window, "click", onClick, true);
    _addEventListener.call(document, "mouseleave", onMouseLeave, true);
    _addEventListener.call(window, "resize", onScrollOrResize);
    _addEventListener.call(window, "scroll", onScrollOrResize, true);
  }

  function deactivate() {
    if (state === "inactive") return;
    state = "inactive";
    _removeEventListener.call(window, "mousemove", onMouseMove, true);
    _removeEventListener.call(window, "click", onClick, true);
    _removeEventListener.call(document, "mouseleave", onMouseLeave, true);
    _removeEventListener.call(window, "resize", onScrollOrResize);
    _removeEventListener.call(window, "scroll", onScrollOrResize, true);
    // Selected overlays stay visible (the Builder keeps the selections);
    // only the hover overlay goes away.
    hideHover();
  }

  // --- message bridge ----------------------------------------------------
  //
  // Accept ONLY the three Builder commands, ONLY from window.parent.
  // Never forward messages from nested iframes (Dyad bubbles a child's
  // reload shortcut up — we do not: any nested frame's message is
  // ignored outright). No reply, no "initialized" ping, no state leak.
  _addEventListener.call(window, "message", function (e) {
    if (e.source !== window.parent) return;
    if (!e.data || typeof e.data !== "object") return;
    var type = e.data.type;
    if (type === "omp-picker-activate") activate();
    else if (type === "omp-picker-deactivate") deactivate();
    else if (type === "omp-picker-clear-overlays") clearOverlays();
    // Everything else is ignored silently.
  });
})();
