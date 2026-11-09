import { useNavigate } from 'react-router-dom';
import { Boxes, MessageSquareText, ReceiptText } from 'lucide-react';
import type { ActionCardsStats } from '../services/dashboardService';

type ActionCardConfig = {
  id: 'chats' | 'payments' | 'stock';
  title: string;
  countKey: keyof ActionCardsStats;
  countLabel: (count: number) => string;
  icon: typeof MessageSquareText;
  iconTone: string;
  borderAccent: string;
  hoverBorder: string;
  route: string;
  showPulse?: boolean;
};

type Props = {
  stats: ActionCardsStats;
  loadState: 'loading' | 'ready' | 'error';
};

const CARDS: ActionCardConfig[] = [
  {
    id: 'chats',
    title: 'Atender Chats',
    countKey: 'pendingChatsCount',
    countLabel: (count) => `${count} ${count === 1 ? 'pendiente' : 'pendientes'}`,
    icon: MessageSquareText,
    iconTone: 'bg-[#128C7E]/10 text-[#128C7E]',
    borderAccent: 'border-l-[#128C7E]',
    hoverBorder: 'hover:border-[#128C7E]/30',
    route: '/gestion-web/inicio',
    showPulse: true,
  },
  {
    id: 'payments',
    title: 'Validar Pagos',
    countKey: 'pendingPaymentsCount',
    countLabel: (count) => `${count} ${count === 1 ? 'comprobante' : 'comprobantes'}`,
    icon: ReceiptText,
    iconTone: 'bg-blue-50 text-blue-600 border border-blue-100',
    borderAccent: '',
    hoverBorder: 'hover:border-blue-300',
    route: '/dashboard/pagos',
  },
  {
    id: 'stock',
    title: 'Actualizar Stock',
    countKey: 'lowStockCount',
    countLabel: (count) => `${count} ${count === 1 ? 'alerta' : 'alertas'} de stock`,
    icon: Boxes,
    iconTone: 'bg-[#91462e]/5 text-[#91462e] border border-[#91462e]/10',
    borderAccent: '',
    hoverBorder: 'hover:border-[#91462e]/30',
    route: '/dashboard/inventario',
  },
];

export default function ActionCards({ stats, loadState }: Props) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
      {CARDS.map((card) => {
        const Icon = card.icon;
        const count = loadState === 'ready' ? stats[card.countKey] : null;
        const isUrgent = card.showPulse && count !== null && count > 0;

        return (
          <button
            key={card.id}
            type="button"
            onClick={() => navigate(card.route)}
            className={`group flex flex-col justify-between rounded-2xl border border-[#D9E5DF] border-l-4 bg-white p-6 text-left shadow-sm transition-all hover:shadow-md ${card.borderAccent} ${card.hoverBorder}`}
          >
            <div className="mb-4 flex items-start justify-between">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-xl transition-transform group-hover:scale-105 ${card.iconTone}`}
              >
                <Icon className="h-5 w-5" />
              </div>
              {isUrgent && (
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
              )}
            </div>
            <div>
              <h4 className="mb-1 text-base font-bold text-[#10231C]">{card.title}</h4>
              <p className="text-[13px] font-medium text-[#5B6F66]">
                {loadState === 'error' ? 'No disponible' : count === null ? 'Cargando…' : card.countLabel(count)}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
