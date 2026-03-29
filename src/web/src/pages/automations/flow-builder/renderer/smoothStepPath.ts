/**
 * Pure function that computes an SVG path string for a smooth-step edge.
 * Replaces @xyflow/react's getSmoothStepPath.
 *
 * Draws a vertical path from source to target with rounded corners
 * when there's a horizontal offset (e.g., conditional branches).
 */

export function smoothStepPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  borderRadius = 16,
): string {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;

  // Straight vertical line (or nearly straight)
  if (Math.abs(dx) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  // Smooth step: go down to midpoint, turn horizontally, then go down to target
  const midY = sourceY + dy / 2;
  const r = Math.min(borderRadius, Math.abs(dx) / 2, Math.abs(dy) / 4);
  const sign = dx > 0 ? 1 : -1;

  // Path: vertical down → rounded corner → horizontal → rounded corner → vertical down
  return [
    `M ${sourceX} ${sourceY}`,
    // Vertical segment down to first corner
    `L ${sourceX} ${midY - r}`,
    // First rounded corner (turn toward target)
    `Q ${sourceX} ${midY} ${sourceX + sign * r} ${midY}`,
    // Horizontal segment
    `L ${targetX - sign * r} ${midY}`,
    // Second rounded corner (turn down)
    `Q ${targetX} ${midY} ${targetX} ${midY + r}`,
    // Vertical segment down to target
    `L ${targetX} ${targetY}`,
  ].join(' ');
}
