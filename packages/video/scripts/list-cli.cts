/**
 * Registry introspection CLI runner. Prints the currently-registered
 * primitives / scene kinds / transitions to stdout.
 *
 * Invoked by `ohwow video list <primitives|scenes|transitions>`.
 */
import { listLayerPrimitives } from "../src/layers/registry";
import { listSceneKinds } from "../src/scenes/registry";
import { listTransitions } from "../src/transitions/registry";

const kind = process.argv[2];

function printPrimitives(): void {
  const entries = listLayerPrimitives().sort((a, b) => a.name.localeCompare(b.name));
  process.stdout.write("name                  builtin  params\n");
  process.stdout.write("────                  ───────  ──────\n");
  for (const e of entries) {
    const builtin = e.builtin ? "  yes  " : "       ";
    const params = e.paramWhitelist.join(", ");
    process.stdout.write(`${e.name.padEnd(22)}${builtin}  ${params}\n`);
    if (e.description) {
      process.stdout.write(`${" ".repeat(22)}${" ".repeat(7)}  ${e.description}\n`);
    }
  }
  process.stdout.write(`\n${entries.length} primitives registered.\n`);
}

function printScenes(): void {
  const kinds = listSceneKinds().sort();
  for (const k of kinds) process.stdout.write(`${k}\n`);
  process.stdout.write(`\n${kinds.length} scene kinds registered.\n`);
}

function printTransitions(): void {
  const entries = listTransitions().sort((a, b) => a.name.localeCompare(b.name));
  process.stdout.write("name      builtin  description\n");
  process.stdout.write("────      ───────  ───────────\n");
  for (const e of entries) {
    const builtin = e.builtin ? "  yes  " : "       ";
    process.stdout.write(`${e.name.padEnd(10)}${builtin}  ${e.description ?? ""}\n`);
  }
  process.stdout.write(`\n${entries.length} transitions registered. (kind="none" is a sentinel and isn't listed.)\n`);
}

switch (kind) {
  case "primitives": printPrimitives(); break;
  case "scenes": printScenes(); break;
  case "transitions": printTransitions(); break;
  default:
    process.stderr.write("Usage: list-cli.cts <primitives|scenes|transitions>\n");
    process.exit(2);
}
