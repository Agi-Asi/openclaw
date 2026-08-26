import { resolvePositionalSeg } from "../oc-path.js";
import type { JsoncValue } from "./ast.js";

export function resolveJsoncPositionalSeg(node: JsoncValue, segment: string): string | null {
  if (node.kind === "object") {
    const keys = node.entries.map((entry) => entry.key);
    return resolvePositionalSeg(segment, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === "array") {
    return resolvePositionalSeg(segment, { indexable: true, size: node.items.length });
  }
  return null;
}
