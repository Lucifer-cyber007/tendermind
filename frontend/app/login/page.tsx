"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await api.auth.login(email, password);
      localStorage.setItem("token", response.access_token);
      router.push("/dashboard");
    } catch {
      setError("Login failed. Please check your email and password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-text-primary">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px]">
        <section className="hidden w-2/5 flex-col justify-between bg-primary px-10 py-12 text-white lg:flex">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-blue-100">TenderMind</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight">
              Procurement
              <br />
              Evaluation System
            </h1>
            <p className="mt-5 max-w-md text-base text-blue-100">
              Eliminating manual errors in government procurement
            </p>
            <div className="mt-10 grid gap-3">
              {["Vigilance Ready", "Audit Trail", "AI-Assisted"].map((badge) => (
                <div
                  key={badge}
                  className="w-fit rounded-full border border-blue-300/30 bg-blue-400/10 px-4 py-1.5 text-sm font-medium"
                >
                  {badge}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-blue-300/25 bg-blue-400/10 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-blue-100">Government of India</p>
            <p className="mt-1 text-sm font-medium">CRPF Procurement Cell</p>
          </div>
        </section>

        <section className="flex w-full items-center justify-center bg-surface px-6 py-12 lg:w-3/5 lg:px-16">
          <div className="w-full max-w-md">
            {searchParams.get("registered") === "true" ? (
              <div className="mb-5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                Account created. Sign in to continue.
              </div>
            ) : null}
            <div className="mb-8 lg:hidden">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">TenderMind</p>
              <p className="mt-2 text-sm text-text-secondary">
                Eliminating manual errors in government procurement
              </p>
            </div>

            <h2 className="text-3xl font-semibold text-text-primary">Officer Sign In</h2>
            <p className="mt-2 text-sm text-text-secondary">Use your official account to continue.</p>

            <form className="mt-8 space-y-5" onSubmit={onSubmit}>
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/20"
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/20"
                />
              </div>

              {error ? (
                <div className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={loading}
                className="inline-flex w-full items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Signing in...
                  </span>
                ) : (
                  "Sign In"
                )}
              </button>
            </form>

            <p className="mt-6 text-sm text-text-secondary">
              New officer?{" "}
              <Link href="/register" className="font-medium text-accent hover:underline">
                Register here
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
