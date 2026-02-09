# MatrixMint — Evidence-Locked Proposal Orchestrator (Gemini 3)

MatrixMint turns an RFP (Request for Proposal) into an **evidence-locked compliance matrix**, verifies every claim, then exports a **bid-ready submission packet**.

**Why it matters:** In procurement, hallucinated claims = real risk. MatrixMint is built to produce **trustable AI outputs** that are reviewable by legal, security, and delivery teams.

---

## What MatrixMint Does

**Pipeline**
1. **Analyze**: Parse an RFP into a structured requirement matrix  
2. **Evidence-Lock**: Draft responses only when they can be supported by provided capability evidence  
3. **Proof Verification**: Self-check loop verifies claim ↔ evidence references  
4. **Export**: Generate a bid-ready packet (one file) + individual artifacts

**Outputs (Exports)**
- `proofpack_md` — evidence linkages for review
- `bidpacket_md` — structured bid response
- `proposal_draft_md` — narrative proposal draft
- `clarifications_email_md` — clarifying questions to reduce risk early
- `risks_csv` — risk register for internal stakeholders

---

## What Makes It “Gemini 3”

MatrixMint is not a prompt wrapper. Gemini 3 is used for:
- **Reasoning** over messy RFP language into a usable matrix
- **Multi-step tool orchestration** (analyze → prove → export)
- **Low-latency iteration** for real procurement workflows
- **Self-check proof loop** to verify claims before documents are produced

---

## Demo (Judges: fastest path)

Open the app and go to:

- **`/demo`** → “Submission Mode”
  - Click **Run One-Click Demo**
  - Then click **Download Packet (LIVE)** (or **FAST** if rate limited)

**Key metrics to watch**
- **Coverage**: how much of the RFP was addressed
- **Proof**: % of claims that successfully tie back to evidence references
- **Exports**: confirms packet artifacts are generated

---

## API Quick Tests (copy/paste)

### 1) Samples list
```bash
curl -sS http://127.0.0.1:3000/api/samples | jq '{count:(.samples|length), first:(.samples[0].id//null)}'
```

### 2) Run (LIVE preferred; auto-fallback to CACHE on quota)
```bash
curl -sS -X POST http://127.0.0.1:3000/api/run \
  -H "Content-Type: application/json" \
  -H "x-matrixmint-mode: live" \
  -H "x-matrixmint-bust-cache: 1" \
  -d '{"sampleId":"disaster-relief","model":"gemini-3-flash-preview","download":false}' \
| jq '{ok:.ok, lane:.orchestrator.ladderUsed, model:.orchestrator.modelUsed, proof:.runSummary.proof, coverage:.runSummary.coveragePercent}'
```

### 3) Download the submission packet (one file)
```bash
RID=$(curl -sS -X POST http://127.0.0.1:3000/api/run \
  -H "Content-Type: application/json" \
  -H "x-matrixmint-mode: live" \
  -H "x-matrixmint-bust-cache: 1" \
  -d '{"sampleId":"disaster-relief","model":"gemini-3-flash-preview","download":false}' \
| jq -r '.orchestrator.runId')

curl -sS "http://127.0.0.1:3000/api/runs/$RID?download=1" -o "matrixmint-run-$RID.json"

jq '{ok, lane:.orchestrator.ladderUsed, model:.orchestrator.modelUsed, exports:(.exports|keys)}' "matrixmint-run-$RID.json"
```

---

## Local Development
**Prereqs**
- Node.js 18+ (recommended)
- npm

### Install + run
```bash
npm ci
npm run dev
```
Open http://localhost:3000

### Production build (sanity)
```bash
npm ci
npm run build
npm run start
```

## Configuration

Set your Gemini API key in `.env.local` (see `.env.example` if present).

If your environment has proxy / localhost origin issues, you can set:

- `MATRIXMINT_INTERNAL_ORIGIN` *(optional)* — internal server-to-server calls

---

## Notes on LIVE vs FAST

- **LIVE**: attempts fresh Gemini execution; may be rate-limited depending on quota  
- **FAST**: uses cache replay for reliability and consistent judging  
- MatrixMint automatically falls back to **CACHE** when LIVE is unavailable and records the attempts for transparency.

---

## License

MIT


