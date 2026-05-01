import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#1a3c5e",
        accent: "#2563eb",
        success: "#16a34a",
        warning: "#d97706",
        danger: "#dc2626",
        background: "#f8fafc",
        surface: "#ffffff",
        border: "#e2e8f0",
        "text-primary": "#0f172a",
        "text-secondary": "#64748b",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
