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

test("CLI resolves arbitrary edit targets as semantic parts", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/runs/run_1/editor/intents/apply");
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          document: { saveState: { revision: 4 } },
          preview: { changedPixels: 4 },
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
      ["edit", "recolor", "run_1", "--target", "hood", "--color", "#445566"],
      `http://127.0.0.1:${address.port}`
    );
    await cli.getOutput();
    assert.deepEqual(JSON.parse(receivedBody), {
      intent: {
        color: "#445566",
        intent: "recolor-target",
        preserveOutline: true,
        target: { kind: "semantic-part", part: "hood" },
      },
    });
  } finally {
    server.close();
  }
});

test("CLI requests vision-to-pixel plans through the local HTTP API", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      "/runs/run_1/editor/vision-to-pixel/preview"
    );
    request.on("data", (chunk: Buffer) => {
      receivedBody += chunk.toString("utf-8");
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          plan: {
            canvas: { height: 64, width: 64 },
            features: [{ id: "face", kind: "face-candidate" }],
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
        "vision",
        "plan",
        "run_1",
        "frame_01",
        "--expected-revision",
        "4",
        "--sampling",
        "nearest",
        "--source",
        "/tmp/source.png",
        "--width",
        "64",
        "--height",
        "64",
        "--colors",
        "12",
        "--crop",
        "contain",
      ],
      `http://127.0.0.1:${address.port}`
    );
    const result = await cli.getOutput();
    assert.deepEqual(JSON.parse(result.stdout), {
      plan: {
        canvas: { height: 64, width: 64 },
        features: [{ id: "face", kind: "face-candidate" }],
      },
    });
    assert.deepEqual(JSON.parse(receivedBody), {
      canvas: { height: 64, width: 64 },
      cropMode: "contain",
      frameId: "frame_01",
      maxColors: 12,
      sourcePath: "/tmp/source.png",
      expectedRevision: 4,
      sampling: "nearest",
    });
  } finally {
    server.close();
  }
});

for (const changesDuringRead of [false, true]) {
  test(`CLI observe ${changesDuringRead ? "rejects mixed revisions" : "collects frame context and resolves preview URLs"}`, async () => {
    let reads = 0;
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/runs/run_1/editor") {
        reads += 1;
        response.end(JSON.stringify({ document: {
          runId: "run_1", selectedFrameId: "frame_01",
          saveState: { revision: changesDuringRead ? reads : 4 },
          canvas: { width: 2, height: 1 }, masks: [], selection: {}, timeline: {},
          frames: [{ frameId: "frame_01", grid: { cells: ["#ff0000", null] } }],
        } }));
      } else {
        assert.equal(request.url, "/runs/run_1/editor/frames/frame_01/inspect");
        response.end(JSON.stringify({ inspection: {
          fullPreviewUrl: "/preview.png", pixelMapUrl: "/pixels", zoomHints: [],
        } }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const api = `http://127.0.0.1:${address.port}`;
      const cli = runCli(["observe", "run_1"], api);
      if (changesDuringRead) {
        await assert.rejects(cli.getOutput(), /Editor changed during observation/);
      } else {
        const result = JSON.parse((await cli.getOutput()).stdout);
        assert.equal(result.revision, 4);
        assert.deepEqual(result.frame.grid.cells, ["#ff0000", null]);
        assert.equal(result.inspection.fullPreviewUrl, `${api}/preview.png`);
        assert.equal(reads, 2);
      }
    } finally { server.close(); }
  });
}

for (const sample of [
  { command: "polygon", json: { points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 2, y: 4 }] },
    flags: ["--mode", "outline", "--thickness", "2"], expected: { type: "polygon-pixels", mode: "outline", thickness: 2 } },
  { command: "mirror", json: { sourceBounds: { x: 1, y: 1, width: 3, height: 3 } },
    flags: ["--axis", "vertical", "--axis-position", "7.5", "--copy-transparent"],
    expected: { type: "mirror-pixels", axis: "vertical", axisPosition: 7.5, copyTransparent: true } },
  { command: "paint-mask", json: { color: null }, flags: ["--respect-alpha"],
    expected: { type: "paint-mask", color: null, respectAlpha: true } },
]) {
  test(`CLI forwards ${sample.command} geometry, mask targets and revision`, async () => {
    let body = "";
    const server = createServer((request, response) => {
      assert.equal(request.method, "PATCH");
      assert.equal(request.url, "/runs/run_1/editor/operations");
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ document: {} }));
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); assert.ok(address && typeof address === "object");
      await runCli(["tools", sample.command, "run_1", "frame_01", "--json", JSON.stringify(sample.json),
        "--masks", "body,head", "--expected-revision", "8", ...sample.flags],
        `http://127.0.0.1:${address.port}`).getOutput();
      const payload = JSON.parse(body);
      assert.equal(payload.expectedRevision, 8);
      assert.deepEqual(payload.operations, [{
        ...(sample.command !== "mirror" ? { color: "#111111" } : {}),
        ...sample.json, ...sample.expected, frameId: "frame_01", targetMaskLayerIds: ["body", "head"],
      }]);
    } finally { server.close(); }
  });
}

test("CLI forwards 3D edit batches with the independent model revision",async()=>{
  let body="";
  const server=createServer((request,response)=>{
    assert.equal(request.method,"PATCH");assert.equal(request.url,"/runs/run_3d/voxel/operations");
    request.on("data",(chunk:Buffer)=>{body+=chunk.toString();});request.on("end",()=>{response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({revision:8,model:null}));});
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  try{const address=server.address();assert.ok(address&&typeof address==="object");const operations=[{type:"extrude",points:[{x:1,y:2,z:3}],face:"front",distance:2}];const result=await runCli(["voxel","operations","run_3d","--expected-revision","7","--json",JSON.stringify({operations})],`http://127.0.0.1:${address.port}`).getOutput();assert.deepEqual(JSON.parse(body),{operations,expectedRevision:7});assert.equal(JSON.parse(result.stdout).revision,8);}finally{server.close();}
});
