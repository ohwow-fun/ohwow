export interface PromptItem {
  text: string;
  time: string;
  app: string;
}

export interface FloatingIcon {
  icon: string;
  x: number;
  y: number;
  delay: number;
  scale?: number;
}

export interface OrbitingIcon {
  emoji: string;
  size: number;
  orbit: number;
  speed: number;
  radius: number;
  yRatio: number;
}

export interface PromptsGridParams {
  prompts: PromptItem[];
  stagger: number;
  scrollRange: [number, number];
  appColors: Record<string, string>;
}

export interface DropParams {
  files: { name: string; source: string; color: string; delay: number }[];
  counters: { to: number; label: string; startFrame: number }[];
}

export interface ExtractionParams {
  cards: { type: string; text: string; delay: number }[];
  particleCount: number;
  counter: { to: number; label: string; startFrame: number; durationFrames: number };
}

export interface OutcomeOrbitParams {
  outcomes: { text: string; color: string; icon: string; delay: number }[];
  floatingIcons: OrbitingIcon[];
  connectionDots: { seed: string; speed: number; size: number }[];
  orbitalRings: number;
}

export interface CtaMeshParams {
  notifications: { text: string; icon: string; color: string; delay: number }[];
  terminalLines: { t: string; c: string; d: number }[];
  cta: {
    tagline: string;
    subline: string;
    logoSrc: string;
    wordmark: string;
    showDotFun: boolean;
  };
  ctaStartFrame: number;
}

export interface ScenePayload {
  "prompts-grid": PromptsGridParams;
  drop: DropParams;
  extraction: ExtractionParams;
  "outcome-orbit": OutcomeOrbitParams;
  "cta-mesh": CtaMeshParams;
}
