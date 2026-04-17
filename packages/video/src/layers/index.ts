export type {
  VisualLayer,
  VisualLayerPrimitive,
  BuiltinVisualLayerPrimitive,
  TextLayer,
  TextAnimation,
  TextPosition,
  VideoPalette,
} from "./types";
export { PRIMITIVE_CATALOG } from "./types";
export { LayerRenderer, LayerStack } from "./LayerRenderer";
export { TextLayerRenderer } from "./TextLayerRenderer";
export {
  registerLayerPrimitive,
  unregisterLayerPrimitive,
  getLayerPrimitive,
  hasLayerPrimitive,
  listLayerPrimitives,
  LayerPrimitiveConflictError,
  POSITION_KEYS,
  type PrimitiveComponent,
  type PrimitiveCatalogEntry,
} from "./registry";
