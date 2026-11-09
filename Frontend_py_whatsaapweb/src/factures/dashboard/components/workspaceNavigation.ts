import {
  Activity,
  BarChart3,
  Hand,
  Inbox,
  LayoutDashboard,
  Layers3,
  Package,
  ReceiptText,
  Send,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface WorkspaceLink {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  exact?: boolean;
}

interface WorkspaceSection {
  label: string;
  links: WorkspaceLink[];
}

export const workspaceSections: WorkspaceSection[] = [
  {
    label: 'Operación',
    links: [
      { to: '/gestion-web/inicio', label: 'Bandeja de entrada', icon: Inbox },
      { to: '/dashboard', label: 'Resumen', icon: LayoutDashboard, exact: true },
      { to: '/dashboard/handoff', label: 'Escalaciones', icon: Hand },
      { to: '/gestion-web/reportes', label: 'Reportes', icon: BarChart3 },
    ],
  },
  {
    label: 'Automatización',
    links: [
      { to: '/dashboard/ia/agentes', label: 'Agentes', icon: Sparkles, adminOnly: true },
      { to: '/dashboard/ia/dominios', label: 'Dominios de IA', icon: Layers3, adminOnly: true },
      { to: '/dashboard/campanas', label: 'Campañas', icon: Send },
      { to: '/dashboard/segmentos', label: 'Segmentos', icon: Users },
    ],
  },
  {
    label: 'Comercial',
    links: [
      { to: '/dashboard/catalogos', label: 'Catálogos', icon: Layers3, adminOnly: true },
      { to: '/dashboard/inventario', label: 'Inventario', icon: Package },
      { to: '/dashboard/pagos', label: 'Validación de pagos', icon: ReceiptText },
    ],
  },
  {
    label: 'Administración',
    links: [
      { to: '/gestion-web/administrar-estaciones', label: 'Estaciones', icon: Server },
      { to: '/gestion-web/settings/general', label: 'Configuración', icon: Settings },
      { to: '/gestion-web/permisos', label: 'Permisos', icon: Shield, adminOnly: true },
      { to: '/dashboard/admin/auditoria', label: 'Auditoría', icon: ShieldCheck, adminOnly: true },
      { to: '/dashboard/admin/salud', label: 'Salud del sistema', icon: Activity, adminOnly: true },
    ],
  },
];

export function getWorkspacePage(pathname: string) {
  for (const section of workspaceSections) {
    const link = section.links.find(({ to, exact }) => (
      pathname === to || (!exact && pathname.startsWith(`${to}/`))
    ));
    if (link) return { section: section.label, title: link.label };
  }

  return { section: 'Espacio de trabajo', title: 'Whatsap Automat' };
}
