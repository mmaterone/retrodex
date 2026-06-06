#!/usr/bin/env node
import { readFile } from "node:fs/promises";

interface CliOptions {
  api: string;
  args: string[];
  json?: unknown;
}

const defaultApi = "http://127.0.0.1:5175";
const semanticRoles = new Set([
  "background",
  "body",
  "clothes",
  "eyes",
  "face",
  "hair",
  "head",
  "mouth",
  "prop",
  "shadow",
  "unknown",
  "weapon",
]);

const parseArgs = async (argv: string[]): Promise<CliOptions> => {
  const args = [...argv];
  let api = process.env.PIXEL_CHARACTER_API ?? defaultApi;
  let json: unknown;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--api") {
      api = args[index + 1] ?? api;
      args.splice(index, 2);
      index -= 1;
    } else if (arg === "--json") {
      json = JSON.parse(args[index + 1] ?? "{}");
      args.splice(index, 2);
      index -= 1;
    } else if (arg === "--json-file") {
      json = JSON.parse(await readFile(args[index + 1] ?? "", "utf-8"));
      args.splice(index, 2);
      index -= 1;
    }
  }
  return { api: api.replace(/\/$/u, ""), args, json };
};

const option = (
  args: string[],
  name: string,
  fallback?: string
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const intOption = (args: string[], name: string, fallback = 0): number =>
  Number.parseInt(option(args, name, String(fallback)) ?? String(fallback), 10);

const listOption = (args: string[], name: string): string[] => {
  const value = option(args, name, "");
  return value ? value.split(",").filter(Boolean) : [];
};

const expectedRevisionBody = (
  args: string[],
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const value = option(args, "--expected-revision");
  return value === undefined
    ? payload
    : { ...payload, expectedRevision: Number.parseInt(value, 10) };
};

const boundsFromOptions = (args: string[]) => ({
  height: intOption(args, "--height"),
  width: intOption(args, "--width"),
  x: intOption(args, "--x"),
  y: intOption(args, "--y"),
});

const objectJson = (json: unknown): Record<string, unknown> =>
  typeof json === "object" && json !== null
    ? (json as Record<string, unknown>)
    : {};

const targetFromOption = (target: string | undefined): Record<string, unknown> =>
  semanticRoles.has(target ?? "")
    ? { kind: "semantic-role", role: target }
    : { kind: "semantic-part", part: target ?? "unknown" };

const request = async <T>(
  api: string,
  path: string,
  init?: RequestInit
): Promise<T> => {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }
  return payload as T;
};

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

// eslint-disable-next-line complexity
const run = async (): Promise<void> => {
  const { api, args, json } = await parseArgs(process.argv.slice(2));
  const [group, command, id, subcommand] = args;

  if (group === "runs" && command === "list") {
    print(await request(api, "/runs"));
    return;
  }
  if (group === "runs" && command === "create") {
    print(
      await request(api, "/runs", {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "runs" && command === "show" && id) {
    print(await request(api, `/runs/${id}`));
    return;
  }

  if (group === "frames" && command === "add" && id) {
    print(
      await request(api, `/runs/${id}/frames`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "frames" && command === "show" && id && subcommand) {
    print(await request(api, `/runs/${id}/frames/${subcommand}`));
    return;
  }
  if (group === "frames" && command === "approve" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/frames/${subcommand}/approve`, {
        body: JSON.stringify(json ?? { approved: true, approvedBy: "agent" }),
        method: "POST",
      })
    );
    return;
  }
  if (group === "frames" && command === "image" && id && subcommand) {
    print({ url: `${api}/runs/${id}/frames/${subcommand}/image` });
    return;
  }

  if (group === "cleanup" && command === "start" && id) {
    print(await request(api, `/runs/${id}/cleanup`, { method: "POST" }));
    return;
  }
  if (group === "cleanup" && command === "status" && id) {
    print(await request(api, `/jobs/${id}`));
    return;
  }
  if (group === "cleanup" && command === "cancel" && id) {
    print(
      await request(api, `/jobs/${id}`, {
        body: JSON.stringify({ action: "cancel" }),
        method: "POST",
      })
    );
    return;
  }

  if (group === "editor" && command === "import-approved" && id) {
    print(
      await request(api, `/runs/${id}/editor/import-approved`, {
        method: "POST",
      })
    );
    return;
  }
  if (group === "editor" && command === "open" && id) {
    print(await request(api, `/runs/${id}/editor/url`));
    return;
  }
  if (group === "editor" && command === "show" && id) {
    print(await request(api, `/runs/${id}/editor`));
    return;
  }
  if (group === "editor" && command === "status" && id) {
    print(await request(api, `/runs/${id}/editor/status`));
    return;
  }
  if (group === "editor" && command === "save" && id) {
    print(
      await request(api, `/runs/${id}/editor`, {
        body: JSON.stringify(expectedRevisionBody(args, objectJson(json))),
        method: "PUT",
      })
    );
    return;
  }

  if (group === "selection" && command === "show" && id) {
    print(await request(api, `/runs/${id}/editor/selection`));
    return;
  }
  if (group === "selection" && command === "set" && id) {
    print(
      await request(api, `/runs/${id}/editor/selection`, {
        body: JSON.stringify(
          expectedRevisionBody(args, { selection: objectJson(json) })
        ),
        method: "PUT",
      })
    );
    return;
  }

  if (group === "memory" && command === "show" && id) {
    print(await request(api, `/runs/${id}/editor/memory`));
    return;
  }
  if (group === "memory" && command === "save" && id) {
    print(
      await request(api, `/runs/${id}/editor/memory`, {
        body: JSON.stringify(json),
        method: "PUT",
      })
    );
    return;
  }

  if (
    group === "pixels" &&
    ["get", "map", "preview"].includes(command ?? "") &&
    id &&
    subcommand
  ) {
    const path = `/runs/${id}/editor/frames/${subcommand}/pixels`;
    if (command === "preview") {
      print({ url: `${api}/runs/${id}/frames/${subcommand}/image` });
      return;
    }
    print(await request(api, path));
    return;
  }
  if (group === "pixels" && command === "set" && id && subcommand) {
    const current = await request<{
      grid: { cells: (null | string)[]; size: { width: number } };
    }>(api, `/runs/${id}/editor/frames/${subcommand}/pixels`);
    const x = intOption(args, "--x");
    const y = intOption(args, "--y");
    current.grid.cells[y * current.grid.size.width + x] =
      option(args, "--color") ?? null;
    print(
      await request(api, `/runs/${id}/editor/frames/${subcommand}/pixels`, {
        body: JSON.stringify({ grid: current.grid }),
        method: "PUT",
      })
    );
    return;
  }
  if (group === "pixels" && command === "patch" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            { frameId: subcommand, patches: json, type: "patch-pixels" },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "bucket" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              color: option(args, "--color", "#111111"),
              frameId: subcommand,
              respectMaskLayerIds: listOption(args, "--masks"),
              type: "bucket-fill",
              x: intOption(args, "--x"),
              y: intOption(args, "--y"),
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "gradient" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              endCell: {
                x: intOption(args, "--x2"),
                y: intOption(args, "--y2"),
              },
              endColor: option(args, "--end", "#ffffff"),
              frameId: subcommand,
              kind: option(args, "--kind", "linear"),
              pattern: option(args, "--pattern", "bayer"),
              startCell: {
                x: intOption(args, "--x1"),
                y: intOption(args, "--y1"),
              },
              startColor: option(args, "--start", "#111111"),
              target: option(args, "--target", "connected"),
              targetMaskLayerIds: listOption(args, "--masks"),
              type: "gradient-fill",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "shape" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              color: option(args, "--color", "#111111"),
              endCell: {
                x: intOption(args, "--x2"),
                y: intOption(args, "--y2"),
              },
              frameId: subcommand,
              mode: option(args, "--mode", "outline"),
              radius: intOption(args, "--radius"),
              shape: option(args, "--shape", "rectangle"),
              startCell: {
                x: intOption(args, "--x1"),
                y: intOption(args, "--y1"),
              },
              type: "shape-pixels",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "transform" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              ...objectJson(json),
              frameId: subcommand,
              type: "transform-pixels",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "delete-selection" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              ...objectJson(json),
              clearMaskLayerIds: listOption(args, "--clear-masks"),
              frameId: subcommand,
              maskLayerIds: listOption(args, "--masks"),
              type: "delete-selected-pixels",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command === "delete-target" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              bounds: boundsFromOptions(args),
              clearMaskLayerIds: listOption(args, "--clear-masks"),
              frameId: subcommand,
              type: "delete-target",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "tools" && command && id && subcommand) {
    const frameId = option(args, "--frame", subcommand);
    const color = option(args, "--color", "#111111");
    const size = intOption(args, "--size", 1);
    const x = intOption(args, "--x");
    const y = intOption(args, "--y");
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              color,
              frameId,
              points: json ?? [{ x, y }],
              size,
              tool: command,
              type: "tool-stroke",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "edit" && ["preview", "apply"].includes(command ?? "") && id) {
    print(
      await request(api, `/runs/${id}/editor/intents/${command}`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "edit" && command === "recolor" && id) {
    const target = option(args, "--target");
    const maskLayerId = option(args, "--mask");
    const frameId = option(args, "--frame");
    const color = option(args, "--color");
    if (!color) {
      throw new Error("Missing --color for edit recolor.");
    }
    const intent = maskLayerId
      ? {
          color,
          frameId,
          intent: "recolor-mask",
          maskLayerId,
          preserveOutline:
            option(args, "--preserve-outline", "true") !== "false",
        }
      : {
          color,
          frameId,
          intent: "recolor-target",
          preserveOutline:
            option(args, "--preserve-outline", "true") !== "false",
          target: targetFromOption(target),
        };
    print(
      await request(api, `/runs/${id}/editor/intents/apply`, {
        body: JSON.stringify({ intent }),
        method: "POST",
      })
    );
    return;
  }

  if (group === "masks" && command === "list" && id) {
    const result = await request<{ document: { masks: unknown[] } }>(
      api,
      `/runs/${id}/editor`
    );
    print({ masks: result.document.masks });
    return;
  }
  if (group === "masks" && command === "paint" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              layerId: subcommand,
              points: json ?? [
                { x: intOption(args, "--x"), y: intOption(args, "--y") },
              ],
              respectAlpha: option(args, "--respect-alpha", "true") !== "false",
              size: intOption(args, "--size", 1),
              type: "mask-stroke",
              value: option(args, "--value", "true") !== "false",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (group === "masks" && command === "fill" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              excludeOtherMasks:
                option(args, "--exclude-other-masks", "true") !== "false",
              layerId: subcommand,
              respectAlpha: option(args, "--respect-alpha", "true") !== "false",
              type: "mask-bucket",
              value: option(args, "--value", "true") !== "false",
              x: intOption(args, "--x"),
              y: intOption(args, "--y"),
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (group === "masks" && command === "shape" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              endCell: {
                x: intOption(args, "--x2"),
                y: intOption(args, "--y2"),
              },
              layerId: subcommand,
              mode: option(args, "--mode", "outline"),
              radius: intOption(args, "--radius"),
              respectAlpha: option(args, "--respect-alpha", "true") !== "false",
              shape: option(args, "--shape", "rectangle"),
              startCell: {
                x: intOption(args, "--x1"),
                y: intOption(args, "--y1"),
              },
              type: "mask-shape",
              value: option(args, "--value", "true") !== "false",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (
    group === "masks" &&
    ["create", "update", "anchor", "parent"].includes(command ?? "") &&
    id
  ) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              layer: json,
              type: "upsert-mask-layer",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (group === "masks" && command === "delete" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [{ layerId: subcommand, type: "delete-mask-layer" }],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (group === "masks" && command === "label" && id && subcommand) {
    const result = await request<{
      document: { masks: Record<string, unknown>[] };
    }>(api, `/runs/${id}/editor`);
    const layer = result.document.masks.find((item) => item.id === subcommand);
    if (!layer) {
      throw new Error(`Mask layer not found: ${subcommand}`);
    }
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              layer: {
                ...layer,
                promptHint: option(
                  args,
                  "--prompt",
                  String(layer.promptHint ?? "")
                ),
                aliases:
                  listOption(args, "--aliases").length > 0
                    ? listOption(args, "--aliases")
                    : ((layer.aliases as string[] | undefined) ?? []),
                partKind: option(
                  args,
                  "--part-kind",
                  String(layer.partKind ?? layer.semanticLabel ?? layer.name)
                ),
                semanticLabel: option(
                  args,
                  "--label",
                  String(layer.semanticLabel ?? "")
                ),
                semanticRole: option(
                  args,
                  "--role",
                  String(layer.semanticRole ?? "unknown")
                ),
              },
              type: "upsert-mask-layer",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (
    group === "masks" &&
    ["inspect", "suggest", "validate"].includes(command ?? "") &&
    id
  ) {
    const result = await request<{
      maskIntelligence: {
        diagnostics: unknown[];
        recommendations: unknown[];
        suggestions: unknown[];
      };
    }>(api, `/runs/${id}/editor/mask-intelligence`);
    if (command === "suggest") {
      print({ suggestions: result.maskIntelligence.suggestions });
      return;
    }
    if (command === "validate") {
      print({
        diagnostics: result.maskIntelligence.diagnostics,
        recommendations: result.maskIntelligence.recommendations,
      });
      return;
    }
    print(result);
    return;
  }

  if (group === "inspect" && command === "animation" && id) {
    print(await request(api, `/runs/${id}/editor/visual-summary`));
    return;
  }
  if (group === "animation" && command === "inspect" && id) {
    print(await request(api, `/runs/${id}/editor/animation-inspection`));
    return;
  }
  if (group === "animation" && command === "preview" && id) {
    print(
      await request(api, `/runs/${id}/editor/animation-fixes/preview`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (
    group === "animation" &&
    (command === "preview-fix-flicker" ||
      command === "preview-repair-loop-pop" ||
      command === "preview-smooth-mask-motion") &&
    id
  ) {
    print(
      await request(api, `/runs/${id}/editor/animation-fixes/preview`, {
        body: JSON.stringify({
          ...(typeof json === "object" && json ? json : {}),
          mode: command.replace("preview-", ""),
        }),
        method: "POST",
      })
    );
    return;
  }
  if (
    group === "animation" &&
    (command === "fix-flicker" ||
      command === "repair-loop-pop" ||
      command === "smooth-mask-motion") &&
    id
  ) {
    print(
      await request(api, `/runs/${id}/editor/animation-fixes/apply`, {
        body: JSON.stringify({
          ...(typeof json === "object" && json ? json : {}),
          mode: command,
        }),
        method: "POST",
      })
    );
    return;
  }
  if (group === "inspect" && command === "frame" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/frames/${subcommand}/inspect`)
    );
    return;
  }

  if (group === "references" && command === "create" && id) {
    print(
      await request(api, `/runs/${id}/editor/references`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "references" && command === "image" && id && subcommand) {
    print({
      url: `${api}/runs/${id}/editor/references/${subcommand}/image`,
    });
    return;
  }

  if (group === "regenerate" && command === "part" && id) {
    print(
      await request(api, `/runs/${id}/editor/regenerate`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }

  if (group === "imagegen" && command === "request" && id) {
    print(
      await request(api, `/runs/${id}/editor/imagegen-requests`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "imagegen" && command === "result" && id) {
    print(
      await request(api, `/runs/${id}/editor/imagegen-results`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "imagegen" && command === "inspect" && id && subcommand) {
    print(
      await request(
        api,
        `/runs/${id}/editor/imagegen-results/${subcommand}/inspect`
      )
    );
    return;
  }
  if (group === "imagegen" && command === "compare" && id && subcommand) {
    const candidateId =
      option(args, "--candidate") ??
      (typeof json === "object" && json && "candidateId" in json
        ? String(json.candidateId)
        : undefined);
    if (!candidateId) {
      throw new Error("imagegen compare requires --candidate <candidateId>.");
    }
    print({
      url: `${api}/runs/${id}/editor/imagegen-results/${subcommand}/compare/${candidateId}/image`,
    });
    return;
  }
  if (group === "imagegen" && command === "apply-preview" && id && subcommand) {
    print(
      await request(
        api,
        `/runs/${id}/editor/imagegen-results/${subcommand}/apply-preview`,
        {
          body: JSON.stringify(json),
          method: "POST",
        }
      )
    );
    return;
  }
  if (group === "imagegen" && command === "apply" && id && subcommand) {
    print(
      await request(
        api,
        `/runs/${id}/editor/imagegen-results/${subcommand}/apply`,
        {
          body: JSON.stringify(json),
          method: "POST",
        }
      )
    );
    return;
  }

  if (group === "checkpoints" && command === "list" && id) {
    print(await request(api, `/runs/${id}/editor/checkpoints`));
    return;
  }
  if (group === "checkpoints" && command === "create" && id) {
    print(
      await request(api, `/runs/${id}/editor/checkpoints`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "checkpoints" && command === "revert" && id && subcommand) {
    print(
      await request(
        api,
        `/runs/${id}/editor/checkpoints/${subcommand}/revert`,
        {
          body: JSON.stringify(json),
          method: "POST",
        }
      )
    );
    return;
  }
  if (group === "checkpoints" && command === "compare" && id && subcommand) {
    const otherCheckpointId =
      typeof json === "object" &&
      json !== null &&
      "to" in json &&
      typeof json.to === "string"
        ? json.to
        : args[4];
    if (!otherCheckpointId) {
      throw new Error(
        "checkpoints compare requires <runId> <leftId> <rightId>."
      );
    }
    print(
      await request(
        api,
        `/runs/${id}/editor/checkpoints/${subcommand}/compare/${otherCheckpointId}`
      )
    );
    return;
  }

  if (group === "operations" && command === "list" && id) {
    print(await request(api, `/runs/${id}/editor/operations-log`));
    return;
  }
  if (group === "operations" && command === "revert" && id && subcommand) {
    print(
      await request(
        api,
        `/runs/${id}/editor/operations-log/${subcommand}/revert`,
        {
          body: JSON.stringify(json),
          method: "POST",
        }
      )
    );
    return;
  }

  if (group === "timeline" && command === "list" && id) {
    const result = await request<{ document: { timeline: unknown } }>(
      api,
      `/runs/${id}/editor`
    );
    print({ timeline: result.document.timeline });
    return;
  }
  if (group === "timeline" && command === "reorder" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [
            {
              frameId: subcommand,
              targetIndex: intOption(args, "--index"),
              type: "reorder-frame",
            },
          ],
        })),
        method: "PATCH",
      })
    );
    return;
  }
  if (group === "timeline" && command === "select" && id && subcommand) {
    print(
      await request(api, `/runs/${id}/editor/operations`, {
        body: JSON.stringify(expectedRevisionBody(args, {
          operations: [{ frameId: subcommand, type: "select-frame" }],
        })),
        method: "PATCH",
      })
    );
    return;
  }

  if (group === "exports" && command === "create" && id) {
    print(
      await request(api, `/runs/${id}/exports`, {
        body: JSON.stringify(json),
        method: "POST",
      })
    );
    return;
  }
  if (group === "exports" && command === "preview" && id) {
    print(
      await request(api, `/runs/${id}/editor/export-preview`, {
        body: JSON.stringify(expectedRevisionBody(args, objectJson(json))),
        method: "POST",
      })
    );
    return;
  }
  if (group === "exports" && command === "list" && id) {
    print(await request(api, `/runs/${id}/exports`));
    return;
  }
  if (group === "exports" && command === "show" && id && subcommand) {
    print(await request(api, `/runs/${id}/exports/${subcommand}`));
    return;
  }
  if (group === "exports" && command === "artifact" && id && subcommand) {
    const file = option(args, "--file", "saved-animation.json");
    print({
      url: `${api}/runs/${id}/exports/${subcommand}/files/${encodeURIComponent(
        file ?? "saved-animation.json"
      )}`,
    });
    return;
  }

  throw new Error(
    "Unknown command. Try runs, frames, cleanup, editor, memory, pixels, tools, edit, masks, inspect, animation, references, regenerate, imagegen, checkpoints, operations, timeline, or exports."
  );
};

try {
  await run();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
