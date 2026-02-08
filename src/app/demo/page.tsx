import DemoClient from "./DemoClient";

export const metadata = {
  title: "MatrixMint — Submission Mode",
};

export default function DemoPage() {
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>MatrixMint — Submission Mode</h1>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Live Proof compliance matrix + evidence verification + bid-ready exports. One-click demo.
        </p>

        <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800, lineHeight: 1.4 }}>
          Recommended flow: FAST (stable) → LIVE Proof (fresh Gemini) → optional Break+Heal → Download Submission Packet.
        </div>
      </div>

      <DemoClient />
    </main>
  );
}