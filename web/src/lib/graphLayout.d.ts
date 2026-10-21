// Types for graphLayout.js, so the server-side tests can import it under strict TypeScript.
export interface LayoutNode {
  id: string;
  children: LayoutNode[];
  status?: string;
  items?: { seq?: number }[];
}
export interface Layout {
  pos: Map<string, { x: number; y: number; depth: number }>;
  parent: Map<string, string | null>;
  edges: { from: string; to: string }[];
  width: number;
  height: number;
}
export const LAYOUT: { colW: number; rowH: number; padX: number; padY: number };
export function layoutTree(root: LayoutNode, options?: { collapsed?: Set<string>; colW?: number; rowH?: number; padX?: number; padY?: number }): Layout;
export function shapeKey(root: LayoutNode, collapsed?: Set<string>): string;
export function initials(label: string): string;
export function liveNode<T extends LayoutNode>(nodes: Map<string, T>): T | null;
