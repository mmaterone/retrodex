import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

const runCli = (
  args: string[],
  api: string
): {
  child: ReturnType<typeof spawn>;
  getOutput: () => Promise<{ stderr: string; stdout: string }>;
} => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--api", api, ...args],
    { cwd: new URL("..", import.meta.url) }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  return {
    child,
    getOutput: async () => {
      const [code] = (await once(child, "close")) as [number | null];
      if (code !== 0) {
        throw new Error(stderr || `CLI exited with ${code ?? "unknown"}`);
      }
      return { stderr, stdout };
    },
  };
};

test("CLI requests runs through the local HTTP API", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/runs");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runs: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cli = runCli(["runs", "list"], `http://127.0.0.1:${address.port}`);
    const result = await cli.getOutput();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { runs: [] });
  } finally {
    server.close();
  }
});

test("CLI creates targeted part references through the local HTTP API", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/runs/run_1/editor/references");
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        reference: {
          id: "ref_mask_1",
          maskLayerId: "mask_1",
          runId: "run_1",
        },
      })
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cli = runCli(
      ["references", "create", "run_1", "--json", '{"maskLayerId":"mask_1"}'],
      `http://127.0.0.1:${address.port}`
    );
    const result = await cli.getOutput();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      reference: {
        id: "ref_mask_1",
        maskLayerId: "mask_1",
        runId: "run_1",
      },
    });
  } finally {
    server.close();
  }
});

test("CLI exposes delete target as an editor operation", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/runs/run_1/editor/operations");
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ document: { runId: "run_1" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cli = runCli(
      [
        "tools",
        "delete-target",
        "run_1",
        "frame_01",
        "--x",
        "2",
        "--y",
        "3",
        "--width",
        "4",
        "--height",
        "5",
        "--clear-masks",
        "mask_1,mask_2",
      ],
      `http://127.0.0.1:${address.port}`
    );
    const result = await cli.getOutput();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      document: { runId: "run_1" },
    });
    assert.deepEqual(JSON.parse(receivedBody), {
      operations: [
        {
          bounds: { height: 5, width: 4, x: 2, y: 3 },
          clearMaskLayerIds: ["mask_1", "mask_2"],
          frameId: "frame_01",
          type: "delete-target",
        },
      ],
    });
  } finally {
    server.close();
  }
});

test("CLI exposes delete selection with mask layers", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/runs/run_1/editor/operations");
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ document: { runId: "run_1" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cli = runCli(
      [
        "tools",
        "delete-selection",
        "run_1",
        "frame_01",
        "--masks",
        "hair",
        "--clear-masks",
        "hair",
      ],
      `http://127.0.0.1:${address.port}`
    );
    const result = await cli.getOutput();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      document: { runId: "run_1" },
    });
    assert.deepEqual(JSON.parse(receivedBody), {
      operations: [
        {
          clearMaskLayerIds: ["hair"],
          frameId: "frame_01",
          maskLayerIds: ["hair"],
          type: "delete-selected-pixels",
        },
      ],
    });
  } finally {
    server.close();
  }
});

test("CLI reads and writes editor selection with expected revision", async () => {
  let receivedBody = "";
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/runs/run_1/editor/selection");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          selection: { selectedFrameId: "frame_01", transformTarget: "none" },
        })
      );
      return;
    }
    assert.equal(request.method, "PUT");
    assert.equal(request.url, "/runs/run_1/editor/selection");
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          document: { runId: "run_1" },
          selection: { selectedFrameId: "frame_01", transformTarget: "pixels" },
        })
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const api = `http://127.0.0.1:${address.port}`;
    const show = runCli(["selection", "show", "run_1"], api);
    const showOutput = await show.getOutput();
    assert.deepEqual(JSON.parse(showOutput.stdout), {
      selection: { selectedFrameId: "frame_01", transformTarget: "none" },
    });
    const set = runCli(
      [
        "selection",
        "set",
        "run_1",
        "--expected-revision",
        "7",
        "--json",
        '{"selectedFrameId":"frame_01","transformTarget":"pixels"}',
      ],
      api
    );
    const setOutput = await set.getOutput();
    assert.deepEqual(JSON.parse(setOutput.stdout), {
      document: { runId: "run_1" },
      selection: { selectedFrameId: "frame_01", transformTarget: "pixels" },
    });
    assert.deepEqual(JSON.parse(receivedBody), {
      expectedRevision: 7,
      selection: {
        selectedFrameId: "frame_01",
        transformTarget: "pixels",
      },
    });
  } finally {
    server.close();
  }
});

test("CLI previews editor exports without creating a snapshot", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/runs/run_1/editor/export-preview");
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          preview: {
            files: [],
            formats: ["svg"],
            frameIds: ["frame_01"],
            revision: 3,
            warnings: [],
          },
        })
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cli = runCli(
      [
        "exports",
        "preview",
        "run_1",
        "--expected-revision",
        "3",
        "--json",
        '{"formats":["svg"],"scope":"frame"}',
      ],
      `http://127.0.0.1:${address.port}`
    );
    const result = await cli.getOutput();
    assert.deepEqual(JSON.parse(result.stdout), {
      preview: {
        files: [],
        formats: ["svg"],
        frameIds: ["frame_01"],
        revision: 3,
        warnings: [],
      },
    });
    assert.deepEqual(JSON.parse(receivedBody), {
      expectedRevision: 3,
      formats: ["svg"],
      scope: "frame",
    });
  } finally {
    server.close();
  }
});
