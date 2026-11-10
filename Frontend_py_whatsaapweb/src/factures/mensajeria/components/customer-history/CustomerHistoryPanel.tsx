import React from 'react';
import { Link } from 'react-router-dom';
import { orderLocation } from '../../../../shared/navigation/commercialNavigation';
import { AlertCircle, ChevronRight, Clock3, History, Loader2, MessageSquare, RefreshCw, ShoppingBag, Tag, UserRound, X } from 'lucide-react';
import type {
  CustomerHistory,
  CustomerHistoryAction,
  CustomerHistoryConversation,
  CustomerHistoryMessage,
  CustomerHistoryOrder,
  CustomerHistoryTag,
} from '../../types/customerHistoryTypes';

interface CustomerHistoryPanelProps {
  chatId: string;
  history: CustomerHistory | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClose?: () => void;
}

const itemTypeLabels: Record<string, string> = {
  physical_product: 'Producto fisico',
  digital_product: 'Producto digital',
  service: 'Servicio',
  course: 'Curso',
  subscription: 'Suscripcion',
};

function formatDate(value: string | null): string {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return date.toLocaleString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getContactTitle(history: CustomerHistory): string {
  return (
    history.contact.displayName ||
    history.contact.name ||
    history.contact.profileName ||
    history.contact.phone ||
    history.contact.waId ||
    'Cliente'
  );
}

function getTagStyle(tag: CustomerHistoryTag): React.CSSProperties | undefined {
  if (!tag.color || tag.color.startsWith('text-') || tag.color.startsWith('bg-')) return undefined;
  return { color: tag.color, borderColor: tag.color };
}

function labelForAction(type: string): string {
  const labels: Record<string, string> = {
    message_sent: 'Mensaje enviado',
    service_completed: 'Servicio realizado',
  };
  return labels[type] || type.replace(/_/g, ' ');
}

const CustomerHistoryPanel: React.FC<CustomerHistoryPanelProps> = ({
  chatId,
  history,
  loading,
  error,
  onReload,
  onClose,
}) => {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Historial</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">Cliente y contexto</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onReload}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-100"
            aria-label="Actualizar historial"
            title="Actualizar historial"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {onClose && (
            <button
              type="button"
              data-history-initial-focus=""
              onClick={onClose}
              className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-100"
              aria-label="Cerrar historial"
              title="Cerrar historial"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando historial...
          </div>
        ) : error ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        ) : history ? (
          <div className="space-y-4">
            <ContactSummary history={history} />
            <TagsSection tags={history.tags} />
            <OrdersSection orders={history.orders} chatId={chatId} />
            <ActionsSection actions={history.actions} />
            <ConversationsSection conversations={history.conversations} />
            <MessagesSection messages={history.recentMessages} />
          </div>
        ) : (
          <div className="pt-10 text-center text-sm text-gray-500 dark:text-gray-400">
            Selecciona una conversacion para ver el historial.
          </div>
        )}
      </div>
    </aside>
  );
};

const ContactSummary: React.FC<{ history: CustomerHistory }> = ({ history }) => (
  <section>
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <UserRound className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {getContactTitle(history)}
        </h3>
        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
          {history.contact.phone || history.contact.waId || history.contact.externalContactId}
        </p>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Ultima actividad: {formatDate(history.contact.lastSeenAt)}
        </p>
      </div>
    </div>
  </section>
);

const TagsSection: React.FC<{ tags: CustomerHistoryTag[] }> = ({ tags }) => (
  <section>
    <SectionTitle icon={<Tag className="h-4 w-4" />} label="Etiquetas" count={tags.length} />
    {tags.length === 0 ? (
      <EmptyLine text="Sin etiquetas asignadas." />
    ) : (
      <div className="mt-2 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag.id}
            style={getTagStyle(tag)}
            className={`rounded-md border px-2 py-1 text-xs font-medium ${
              tag.color?.startsWith('text-') ? tag.color : 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300'
            }`}
          >
            {tag.name}
          </span>
        ))}
      </div>
    )}
  </section>
);

const OrdersSection: React.FC<{ orders: CustomerHistoryOrder[]; chatId: string }> = ({ orders, chatId }) => (
  <section>
    <SectionTitle icon={<ShoppingBag className="h-4 w-4" />} label="Pedidos" count={orders.length} />
    {orders.length === 0 ? (
      <EmptyLine text="Sin pedidos registrados todavia." />
    ) : (
      <div className="mt-2 space-y-2">
        {orders.slice(0, 5).map((order) => (
          <Link key={order.id} to={orderLocation(1, order.id, chatId)} aria-label={`Abrir pedido #${order.id}`}
            className="block rounded-md border border-gray-200 p-3 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:border-gray-800 dark:hover:bg-gray-900">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">#{order.id} · {order.title}</p>
              <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                {order.status}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{order.serviceType}</p>
            {order.items && order.items.length > 0 && (
              <div className="mt-2 space-y-1">
                {order.items.slice(0, 4).map((item) => (
                  <div key={item.id} className="text-[11px] text-gray-600 dark:text-gray-300">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{item.quantity} x {item.productName}</span>
                      <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                      <span>{itemTypeLabels[item.itemTypeSnapshot || ''] || item.itemTypeSnapshot || 'Item'}</span>
                      {item.availabilityStatus && <span>· {item.availabilityStatus}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {order.stockMovements && order.stockMovements.length > 0 && (
              <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-300">
                Disponibilidad reservada: {order.stockMovements.filter((movement) => ['reservation', 'capacity_reserved', 'reserved'].includes(movement.movementType)).reduce((sum, movement) => sum + movement.quantity, 0)}
              </p>
            )}
            <p className="mt-2 flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
              <Clock3 className="h-3 w-3" />
              {formatDate(order.occurredAt)}
            </p>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              Abrir pedido <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        ))}
      </div>
    )}
  </section>
);

const ActionsSection: React.FC<{ actions: CustomerHistoryAction[] }> = ({ actions }) => (
  <section>
    <SectionTitle icon={<History className="h-4 w-4" />} label="Acciones" count={actions.length} />
    {actions.length === 0 ? (
      <EmptyLine text="Sin acciones registradas." />
    ) : (
      <div className="mt-2 space-y-2">
        {actions.slice(0, 8).map((action) => (
          <div key={action.id} className="border-b border-gray-100 pb-2 last:border-b-0 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">
                {labelForAction(action.actionType)}
              </span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(action.occurredAt)}</span>
            </div>
            {action.description && (
              <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                {action.description}
              </p>
            )}
            {action.actorUserId && (
              <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                Responsable: #{action.actorUserId}
              </p>
            )}
          </div>
        ))}
      </div>
    )}
  </section>
);

const ConversationsSection: React.FC<{ conversations: CustomerHistoryConversation[] }> = ({ conversations }) => (
  <section>
    <SectionTitle icon={<MessageSquare className="h-4 w-4" />} label="Conversaciones" count={conversations.length} />
    {conversations.length === 0 ? (
      <EmptyLine text="Sin conversaciones previas." />
    ) : (
      <div className="mt-2 space-y-2">
        {conversations.map((conversation) => (
          <div key={conversation.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">
                {conversation.title || conversation.chatId}
              </p>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {conversation.status || 'open'}
              </span>
            </div>
            {conversation.lastMessagePreview && (
              <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                {conversation.lastMessagePreview}
              </p>
            )}
            <p className="mt-2 flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
              <Clock3 className="h-3 w-3" />
              {formatDate(conversation.lastMessageAt)}
            </p>
          </div>
        ))}
      </div>
    )}
  </section>
);

const MessagesSection: React.FC<{ messages: CustomerHistoryMessage[] }> = ({ messages }) => (
  <section>
    <SectionTitle icon={<Clock3 className="h-4 w-4" />} label="Mensajes recientes" count={messages.length} />
    {messages.length === 0 ? (
      <EmptyLine text="Sin mensajes recientes." />
    ) : (
      <div className="mt-2 space-y-2">
        {messages.slice(0, 8).map((message) => (
          <div key={message.id} className="border-b border-gray-100 pb-2 last:border-b-0 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {message.direction === 'outbound' ? 'Enviado' : 'Recibido'}
              </span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(message.occurredAt)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-gray-700 dark:text-gray-300">
              {message.body || (message.hasAttachments ? 'Mensaje con adjunto' : 'Sin texto')}
            </p>
          </div>
        ))}
      </div>
    )}
  </section>
);

const SectionTitle: React.FC<{ icon: React.ReactNode; label: string; count: number }> = ({ icon, label, count }) => (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
      <span className="text-gray-400 dark:text-gray-500">{icon}</span>
      {label}
    </div>
    <span className="text-xs text-gray-400 dark:text-gray-500">{count}</span>
  </div>
);

const EmptyLine: React.FC<{ text: string }> = ({ text }) => (
  <p className="mt-2 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
    {text}
  </p>
);

export default CustomerHistoryPanel;
