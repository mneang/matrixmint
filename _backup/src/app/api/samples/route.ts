import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const base = process.cwd();

  const rfpPath = path.join(base, "samples", "rfp_disaster_relief_volunteers.txt");
  const capPath = path.join(base, "samples", "capability_brief_reliefroster.txt");

  const [rfpText, capabilityText] = await Promise.all([
    readFile(rfpPath, "utf-8"),
    readFile(capPath, "utf-8"),
  ]);

  return NextResponse.json({
    samples: [
      {
        id: "disaster-relief",
        name: "Disaster Relief Volunteer Platform (Nonprofit)",
        rfpText,
        capabilityText,
      },
    ],
  });
}