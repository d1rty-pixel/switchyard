import {
  Activity,
  AudioWaveform,
  Blocks,
  Box,
  Boxes,
  Clock,
  Code,
  Container,
  Cpu,
  Database,
  Download,
  FileCog,
  Flame,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Hammer,
  HardDrive,
  Layers,
  Network,
  Package,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  Server,
  ServerCog,
  Shield,
  ShieldCheck,
  Square,
  Terminal,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Curated icon set. Config files reference icons by kebab-case name; unknown
 * names fall back to a neutral node glyph instead of breaking the card.
 */
const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  'audio-waveform': AudioWaveform,
  blocks: Blocks,
  box: Box,
  boxes: Boxes,
  clock: Clock,
  code: Code,
  container: Container,
  cpu: Cpu,
  database: Database,
  download: Download,
  'file-cog': FileCog,
  flame: Flame,
  folder: Folder,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  hammer: Hammer,
  'hard-drive': HardDrive,
  layers: Layers,
  network: Network,
  package: Package,
  pause: Pause,
  play: Play,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  'rotate-cw': RotateCw,
  server: Server,
  'server-cog': ServerCog,
  shield: Shield,
  'shield-check': ShieldCheck,
  square: Square,
  terminal: Terminal,
  'toggle-left': ToggleLeft,
  'toggle-right': ToggleRight,
  'trash-2': Trash2,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
};

/** Sensible default per provider type when a service defines no icon. */
const PROVIDER_ICONS: Record<string, LucideIcon> = {
  command: Terminal,
  systemd: ServerCog,
  compose: Container,
};

export function iconFor(name?: string, providerType?: string): LucideIcon {
  if (name && ICONS[name]) return ICONS[name] as LucideIcon;
  if (providerType && PROVIDER_ICONS[providerType]) return PROVIDER_ICONS[providerType] as LucideIcon;
  return Boxes;
}

export function actionIcon(name?: string): LucideIcon | undefined {
  return name ? ICONS[name] : undefined;
}
