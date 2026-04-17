/**
 * Central registration for all r3f.* primitives. Imported by the
 * scenes/registry bootstrap so that r3f primitives are available
 * by name when an R3F scene instantiates them.
 *
 * Add new primitives here as they land. Each one is registered with a
 * stable "r3f.<name>" identifier that LLM-emitted specs reference.
 */
import { registerR3FPrimitive, type R3FPrimitive } from "../scenes/r3f-registry";
import { CountUpBar } from "./primitives/CountUpBar";
import { ParticleCloud } from "./primitives/ParticleCloud";
import { VersusCards } from "./primitives/VersusCards";
import { NumberSculpture } from "./primitives/NumberSculpture";

let registered = false;

/**
 * Idempotent registration — safe to call multiple times across tests
 * and ad-hoc script invocations.
 */
export function registerR3FPrimitives(): void {
  if (registered) return;
  registerR3FPrimitive("r3f.count-up-bar", CountUpBar as R3FPrimitive);
  registerR3FPrimitive("r3f.particle-cloud", ParticleCloud as R3FPrimitive);
  registerR3FPrimitive("r3f.versus-cards", VersusCards as R3FPrimitive);
  registerR3FPrimitive("r3f.number-sculpture", NumberSculpture as R3FPrimitive);
  registered = true;
}

// Auto-register at module load. Any file that imports from here wires up
// the full r3f.* catalog.
registerR3FPrimitives();
