"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import { api } from "@/lib/api";

const DESIGNATIONS = [
  "Procurement Officer",
  "Assistant Director",
  "Deputy Director",
  "Director",
  "Additional DG",
  "IG",
  "DIG",
  "Commandant",
  "Deputy Commandant",
  "Other",
];

const DEPARTMENTS = [
  "CRPF",
  "BSF",
  "CISF",
  "ITBP",
  "SSB",
  "NSG",
  "Assam Rifles",
  "Coast Guard",
  "MHA",
  "MoD",
  "Other",
];

function passwordStrength(password: string): { label: string; score: number } {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 2) return { label: "Weak", score };
  if (score <= 4) return { label: "Medium", score };
  return { label: "Strong", score };
}

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [designation, setDesignation] = useState("");
  const [department, setDepartment] = useState("");

  const strength = useMemo(() => passwordStrength(password), [password]);

  const goNext = () => {
    if (!fullName.trim()) return setError("Full name is required.");
    if (!email.trim()) return setError("Official email is required.");
    if (!password) return setError("Password is required.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setError("");
    setStep(2);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!designation || !department) {
      setError("Select both designation and department.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      await api.auth.register(fullName.trim(), email.trim(), password, designation, department);
      router.push("/login?registered=true");
    } catch {
      setError("Could not create account. Please verify details and try again.");
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
            <h1 className="mt-4 text-4xl font-semibold leading-tight">Officer Registration</h1>
            <p className="mt-4 text-blue-100">
              "Precision in procurement begins with accountable decision support."
            </p>

            <div className="mt-10 space-y-3">
              {[1, 2].map((s) => {
                const active = step === s;
                const done = step > s;
                return (
                  <div key={s} className="flex items-center gap-3">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${
                        active || done ? "border-white bg-white text-primary" : "border-blue-300/40 text-blue-100"
                      }`}
                    >
                      {done ? "✓" : s}
                    </div>
                    <span className={active ? "font-semibold text-white" : "text-blue-100"}>
                      {s === 1 ? "Identity & Credentials" : "Role & Department"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-blue-300/25 bg-blue-400/10 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.14em] text-blue-100">Government of India</p>
            <p className="mt-1 text-sm font-medium">CRPF Procurement Cell</p>
          </div>
        </section>

        <section className="flex w-full items-center justify-center bg-surface px-6 py-12 lg:w-3/5 lg:px-16">
          <div className="w-full max-w-lg">
            <h2 className="text-3xl font-semibold">Create officer account</h2>
            <p className="mt-2 text-sm text-text-secondary">Complete both steps to begin evaluation workflows.</p>

            <form className="mt-8 space-y-5" onSubmit={onSubmit}>
              {step === 1 ? (
                <>
                  <div>
                    <label htmlFor="fullName" className="mb-1.5 block text-sm font-medium">
                      Full name
                    </label>
                    <input
                      id="fullName"
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
                      Official email
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    />
                    <div className="mt-2">
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full ${
                            strength.label === "Strong"
                              ? "bg-success"
                              : strength.label === "Medium"
                              ? "bg-warning"
                              : "bg-danger"
                          }`}
                          style={{ width: `${Math.max(20, strength.score * 20)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">Strength: {strength.label}</p>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium">
                      Confirm password
                    </label>
                    <input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    />
                  </div>

                  <button
                    type="button"
                    onClick={goNext}
                    className="w-full rounded-xl bg-accent px-4 py-2.5 font-semibold text-white hover:bg-blue-700"
                  >
                    Continue to Step 2
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <label htmlFor="designation" className="mb-1.5 block text-sm font-medium">
                      Designation
                    </label>
                    <select
                      id="designation"
                      value={designation}
                      onChange={(e) => setDesignation(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    >
                      <option value="">Select designation</option>
                      {DESIGNATIONS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="department" className="mb-1.5 block text-sm font-medium">
                      Department
                    </label>
                    <select
                      id="department"
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      className="w-full rounded-xl border border-border px-3 py-2.5 outline-none focus:border-accent focus:ring-4 focus:ring-accent/20"
                      required
                    >
                      <option value="">Select department</option>
                      {DEPARTMENTS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="w-1/3 rounded-xl border border-border px-4 py-2.5 font-medium text-text-secondary hover:bg-slate-50"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex w-2/3 items-center justify-center rounded-xl bg-accent px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-70"
                    >
                      {loading ? "Creating account..." : "Create account"}
                    </button>
                  </div>
                </>
              )}

              {error ? (
                <div className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>
              ) : null}
            </form>

            <p className="mt-6 text-sm text-text-secondary">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-accent hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
