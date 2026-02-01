import Link from "next/link";
import DemoClient from "./DemoClient";

export const metadata = {
  title: "MatrixMint Demo",
};

export default function DemoPage() {
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <div>
          <h1 style={{ fontSize: 28, marginBottom: 8 }}>MatrixMint — Judge Demo</h1>
          <p style={{ marginTop: 0, opacity: 0.8 }}>
            Orchestrator: analyze → evidence-locked matrix → proof → export bid-ready artifacts.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            href="/"
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #ddd",
              textDecoration: "none",
              color: "#111",
              fontWeight: 800,
              background: "#fff",
            }}
            title="Builder view (full analyzer UI)"
          >
            Builder view
          </Link>

          <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 700 }}>
            Recommended: Fast → download exports → live proof
          </span>
        </div>
      </div>

      <DemoClient />
    </main>
  );
}