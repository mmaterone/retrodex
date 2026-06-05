import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const tmpDir = join(root, "tmp-smoke");
const runsDir = join(tmpDir, "runs");
const sourcePath = join(tmpDir, "source.png");
const port = "5195";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZUlEQVR4nO2XMQrAMAwDFdOHVP9/lPoTl3bq1nQIoqCDLF5yyHYgo9ENI+W8PAJJIAlcbLPrwp2f1kuHsobrXkJJ93mrLROwDOETklO1XyRQEUBaYKYigLTATEUAZkb+hjBjFzgB3VYUd7vSVBQAAAAASUVORK5CYII=";

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }
  return payload;
};

const requestBytes = async (path: string): Promise<Uint8Array> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return new Uint8Array(await response.arrayBuffer());
};

const waitForJob = async (jobId: string): Promise<unknown> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const payload = await requestJson<{ job: { status: string } }>(
      `/jobs/${jobId}`
    );
    if (payload.job.status === "succeeded" || payload.job.status === "failed") {
      return payload;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
};

const main = async (): Promise<void> => {
  await rm(tmpDir, { force: true, recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await writeFile(sourcePath, Buffer.from(pngBase64, "base64"));

  const child = spawn(
    "npm",
    ["--workspace", "@retrodex/api", "run", "dev"],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: port,
        RUNS_DIR: runsDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await requestJson("/health");
        break;
      } catch {
        await delay(100);
      }
    }

    const created = await requestJson<{
      run: { id: string };
    }>("/runs", {
      body: JSON.stringify({
        asset: {
          action: "run",
          frames: 1,
          sheet: "single",
          style: "pixel-art",
          type: "character",
          view: "side",
        },
        name: "Backend Smoke",
        sourceFrames: [{ path: sourcePath }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const cleanup = await requestJson<{ job: { id: string } }>(
      `/runs/${created.run.id}/cleanup`,
      { method: "POST" }
    );
    const cleanupResult = await waitForJob(cleanup.job.id);
    await requestJson(`/runs/${created.run.id}/frames/frame_01/approve`, {
      body: JSON.stringify({ approved: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const exportJob = await requestJson<{ job: { id: string } }>(
      `/runs/${created.run.id}/exports`,
      {
        body: JSON.stringify({
          name: "Smoke Export",
          targets: [
            "raw-frames",
            "game-strip",
            "webp",
            "svg",
            "lottie",
            "react",
            "css",
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    const exportResult = await waitForJob(exportJob.job.id);
    const exportsList = await requestJson<{
      exports: { id: string; files: { webp: string } }[];
    }>(`/runs/${created.run.id}/exports`);
    const [savedExport] = exportsList.exports;
    if (!savedExport) {
      throw new Error("Smoke export was not discoverable.");
    }
    await requestJson(`/runs/${created.run.id}/exports/${savedExport.id}`);
    const webp = await requestBytes(
      `/runs/${created.run.id}/exports/${savedExport.id}/files/preview.webp`
    );
    if (webp.length === 0) {
      throw new Error("Smoke export artifact was empty.");
    }
    console.log(
      JSON.stringify(
        {
          cleanupResult,
          exportId: savedExport.id,
          exportResult,
          webpBytes: webp.length,
        },
        null,
        2
      )
    );
  } finally {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => null);
    await rm(tmpDir, { force: true, recursive: true });
  }
};

await main();
