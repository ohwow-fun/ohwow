/**
 * Blocks catalog CLI runner. Invoked by the `ohwow video blocks <cmd>` and
 * `ohwow video add <id>` CLI.
 *
 * Subcommands:
 *   list [--category=<c>]      print the catalog (tab-aligned)
 *   get <id>                   print details for one block (schema + example)
 *   add <id> [--dest=<path>]   copy the block source file into <dest>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute, dirname, basename } from "node:path";
import { BLOCKS, getBlock, listBlocks } from "../src/blocks/catalog";
import type { BlockCategory } from "../src/blocks/types";

interface RegistryManifest {
  version: number;
  blocks: Array<{
    id: string;
    category: BlockCategory;
    files: string[];
    dependencies: string[];
  }>;
}

function readManifest(): RegistryManifest {
  const raw = readFileSync(join(__dirname, "..", "registry.json"), "utf8");
  return JSON.parse(raw) as RegistryManifest;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const a of args) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printList(category?: BlockCategory): void {
  const blocks = listBlocks(category);
  process.stdout.write("id                  category    duration  description\n");
  process.stdout.write("──                  ────────    ────────  ───────────\n");
  for (const b of blocks) {
    const seconds = (b.defaultDurationFrames / 30).toFixed(1) + "s";
    process.stdout.write(
      `${b.id.padEnd(20)}${b.category.padEnd(12)}${seconds.padEnd(10)}${b.description}\n`,
    );
  }
  process.stdout.write(`\n${blocks.length} block${blocks.length === 1 ? "" : "s"}${category ? ` in category "${category}"` : ""}.\n`);
}

function printGet(id: string): void {
  const block = getBlock(id);
  if (!block) {
    process.stderr.write(`Unknown block "${id}". Available: ${BLOCKS.map(b => b.id).join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`${block.name} (${block.id})\n`);
  process.stdout.write(`  category: ${block.category}\n`);
  process.stdout.write(`  default duration: ${block.defaultDurationFrames}f (${(block.defaultDurationFrames / 30).toFixed(1)}s @ 30fps)\n`);
  process.stdout.write(`  description: ${block.description}\n\n`);
  process.stdout.write("  params:\n");
  for (const [key, field] of Object.entries(block.paramSchema)) {
    const req = field.required ? " (required)" : "";
    process.stdout.write(`    ${key}: ${field.type}${req}\n`);
    if (field.description) process.stdout.write(`      ${field.description}\n`);
  }
}

function printAdd(id: string, dest?: string): void {
  const block = getBlock(id);
  if (!block) {
    process.stderr.write(`Unknown block "${id}". Available: ${BLOCKS.map(b => b.id).join(", ")}\n`);
    process.exit(1);
  }
  const manifest = readManifest();
  const entry = manifest.blocks.find(b => b.id === id);
  if (!entry) {
    process.stderr.write(`Block "${id}" is in the catalog but not in registry.json. Report this as a bug.\n`);
    process.exit(1);
  }
  const destDir = dest
    ? (isAbsolute(dest) ? dest : resolve(process.cwd(), dest))
    : resolve(process.cwd(), "blocks");
  mkdirSync(destDir, { recursive: true });

  const copied: string[] = [];
  for (const relPath of entry.files) {
    const srcPath = join(__dirname, "..", relPath);
    const destPath = join(destDir, basename(relPath));
    if (existsSync(destPath)) {
      process.stderr.write(`Refusing to overwrite existing file: ${destPath}\n`);
      process.exit(1);
    }
    const source = readFileSync(srcPath, "utf8");
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, source, "utf8");
    copied.push(destPath);
  }

  process.stdout.write(`Copied ${copied.length} file${copied.length === 1 ? "" : "s"} for "${id}":\n`);
  for (const p of copied) process.stdout.write(`  ${p}\n`);
  process.stdout.write("\nNext step: import and call block.build(params) to produce a Scene, then wrap with a scene id.\n");
  process.stdout.write(`Example:\n`);
  process.stdout.write(`  import { ${camelize(id)} } from "./${basename(entry.files[0], ".ts")}";\n`);
  process.stdout.write(`  const scene = { id: "intro", ...${camelize(id)}.build({ /* params */ }) };\n`);
}

function camelize(id: string): string {
  return id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseFlags(rest);

switch (cmd) {
  case "list": {
    const category = typeof flags.category === "string" ? (flags.category as BlockCategory) : undefined;
    printList(category);
    break;
  }
  case "get": {
    const id = positional[0];
    if (!id) {
      process.stderr.write("Usage: blocks-cli.cts get <block-id>\n");
      process.exit(2);
    }
    printGet(id);
    break;
  }
  case "add": {
    const id = positional[0];
    if (!id) {
      process.stderr.write("Usage: blocks-cli.cts add <block-id> [--dest=<path>]\n");
      process.exit(2);
    }
    const dest = typeof flags.dest === "string" ? flags.dest : undefined;
    printAdd(id, dest);
    break;
  }
  default:
    process.stderr.write("Usage: blocks-cli.cts <list|get|add> [args]\n");
    process.exit(2);
}
