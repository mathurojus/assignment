"use client";

import { useCallback, useState } from "react";

/**
 * Copy a prompt to the clipboard.
 *
 * The reason this exists rather than a plain button: the obvious `navigator.
 * clipboard.writeText` throws on any page served over plain HTTP on a non-localhost
 * origin, which is exactly what a LAN IP dev server is. The failure is silent in
 * most implementations — the promise rejects, nothing on screen changes, and the
 * reader assumes they copied it. So the fallback is not optional.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = useCallback(async () => {
    setState("idle");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        legacyCopy(text);
      }
      setState("copied");
    } catch {
      // Selecting the text so the reader can press Ctrl+C themselves beats a dead
      // button: the content is on the page, one manual step away.
      setState("failed");
    }

    setTimeout(() => setState("idle"), 2000);
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-2.5 py-1 font-mono text-[11px] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)]"
    >
      {state === "copied" ? "copied" : state === "failed" ? "press Ctrl+C" : label}
    </button>
  );
}

/**
 * Copy via a hidden textarea and `document.execCommand("copy")`.
 *
 * Deprecated, and still the only thing that works in the insecure-context case
 * above. `readonly` matters: without it, focus lands in a field that is about to be
 * removed from the DOM, and on iOS Safari that collapses the keyboard mid-tap.
 */
function legacyCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  document.body.appendChild(area);
  try {
    area.select();
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand('copy') returned false");
  } finally {
    document.body.removeChild(area);
  }
}