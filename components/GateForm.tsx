"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { CardBadge } from "@/components/CardBadge";

export function GateForm() {
  const router = useRouter();
  const passwordId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(message: string) {
    setError(message);
    // Keep the field focused (and its contents selected) so a mistyped
    // password can be retried immediately without reaching for the mouse —
    // matters whether the form was submitted by Enter or by clicking Enter.
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 204) {
        router.push("/");
        return;
      }
      fail(res.status === 401 ? "Wrong password." : "Something went wrong — try again shortly.");
    } catch {
      fail("Something went wrong — try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
      <p className="text-sm text-foreground/70">This is a private demo.</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={passwordId} className="text-sm font-medium">
          Password
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="min-h-11 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 text-base outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="min-h-11 shrink-0 rounded-md bg-accent px-6 font-semibold text-accent-contrast transition-[filter] enabled:hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </div>
      </div>
      {error && <CardBadge id={errorId} kind="red" message={error} />}
    </form>
  );
}
