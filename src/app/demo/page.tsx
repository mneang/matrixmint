import DemoClient from "./DemoClient";

export const metadata = {
  title: "MatrixMint Demo",
};

export default function DemoPage() {
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>MatrixMint — Demo</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        One-click orchestrator: analyze → evidence-locked matrix → export bid-ready artifacts. 勝つ。
      </p>
      <DemoClient />
    </main>
  );
}