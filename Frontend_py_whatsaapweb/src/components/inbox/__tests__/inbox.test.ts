/**
 * Automated Component & Interaction Test Suite for PR-F3-04:
 * Omnichannel 4-Panel Inbox, CAS Concurrency, SLA Badges, and WCAG 2.2 AA Accessibility
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  OmnichannelInbox,
  NavigationPanel,
  QueuePanel,
  TimelinePanel,
  ContextPanel,
  ChannelFilterTabs,
  ConversationCard,
  MessageBubble,
  AiSuggestionBanner,
  ServiceWindowWarning,
  MessageComposer,
  TakeoverButton,
  formatSlaBadge,
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  MOCK_AI_SUGGESTIONS,
  MOCK_AGENT_TRACES,
  MOCK_CUSTOMER_ORDERS,
  MOCK_INTERNAL_NOTES,
  type OmnichannelConversation,
  type OmnichannelMessage,
  type AiSuggestionPayload,
} from '../index';

describe('PR-F3-04: Omnichannel 4-Panel Inbox Verification Suite', () => {
  // --------------------------------------------------------------------------
  // Suite 1: Full 4-Panel Architecture & Root Container Rendering
  // --------------------------------------------------------------------------
  describe('1. 4-Panel Workspace Architecture', () => {
    it('renders the complete OmnichannelInbox root container with all 4 panels', () => {
      const html = renderToStaticMarkup(React.createElement(OmnichannelInbox, {}));

      // Root container
      assert.ok(html.includes('data-testid="omnichannel-inbox"'), 'Root container test ID rendered');

      // Panel 1: Navigation
      assert.ok(html.includes('role="navigation"'), 'Panel 1 Navigation role rendered');
      assert.ok(html.includes('aria-label="Navegación principal y canales"'), 'Panel 1 accessible label rendered');
      assert.ok(html.includes('role="tablist"'), 'Channel filter tablist rendered');

      // Panel 2: Work Queue
      assert.ok(html.includes('id="panel-conversation-queue"'), 'Panel 2 Queue section ID rendered');
      assert.ok(html.includes('aria-label="Cola de trabajo de conversaciones"'), 'Panel 2 accessible label rendered');
      assert.ok(html.includes('id="queue-live-announcer"'), 'Polite screen reader live region rendered');

      // Panel 3: Timeline & Composer
      assert.ok(html.includes('role="log"'), 'Panel 3 message log rendered');
      assert.ok(html.includes('aria-label="Historial de mensajes"'), 'Panel 3 message log label rendered');
      assert.ok(html.includes('aria-describedby="composer-keyboard-hint"'), 'Composer accessible hint link rendered');

      // Panel 4: Context
      assert.ok(html.includes('id="context-panel-inspector"'), 'Panel 4 Inspector ID rendered');
      assert.ok(html.includes('role="complementary"'), 'Panel 4 complementary role rendered');
      assert.ok(html.includes('aria-label="Información del cliente y contexto de la conversación"'), 'Panel 4 label rendered');
    });

    it('renders NavigationPanel with search, status pills, and channel tabs', () => {
      const html = renderToStaticMarkup(
        React.createElement(NavigationPanel, {
          currentChannel: 'whatsapp',
          onSelectChannel: () => {},
          searchQuery: 'Carlos',
          onSearchChange: () => {},
          statusFilter: 'ai_handling',
          onSelectStatusFilter: () => {},
          unreadTotalsByChannel: { whatsapp: 3, all: 5 },
        })
      );

      assert.ok(html.includes('role="search"'), 'Search container role rendered');
      assert.ok(html.includes('role="searchbox"'), 'Search input box rendered');
      assert.ok(html.includes('value="Carlos"'), 'Search input displays active query');
      assert.ok(html.includes('role="radiogroup"'), 'Operational status radiogroup rendered');
      assert.ok(html.includes('aria-checked="true"'), 'Selected status radio marked checked');
      assert.ok(html.includes('aria-selected="true"'), 'WhatsApp channel tab marked selected');
    });

    it('renders QueuePanel with conversation list, presence, and count badge', () => {
      const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
          conversations: MOCK_CONVERSATIONS,
          selectedChatId: 'conv-wsp-01',
          onSelectChat: () => {},
          operatorPresence: 'available',
          onPresenceChange: () => {},
        })
      );

      assert.ok(html.includes('role="list"'), 'Queue conversation list role rendered');
      assert.ok(html.includes('role="listitem"'), 'Queue items render as listitems');
      assert.ok(html.includes('role="combobox"'), 'Presence selector role rendered');
      assert.ok(html.includes('Carlos Mendoza'), 'First mock participant rendered');
      assert.ok(html.includes('Elena Ramos'), 'Second mock participant rendered');
    });

    it('renders ContextPanel with customer identity, tags, tool traces, order, and notes', () => {
      const chat = MOCK_CONVERSATIONS[0];
      const html = renderToStaticMarkup(
        React.createElement(ContextPanel, {
          isOpen: true,
          conversation: chat,
          agentTraces: MOCK_AGENT_TRACES['conv-wsp-01'],
          activeOrder: MOCK_CUSTOMER_ORDERS['conv-wsp-01'],
          internalNotes: MOCK_INTERNAL_NOTES['conv-wsp-01'],
          onAddInternalNote: () => {},
          onAddTag: () => {},
          onRemoveTag: () => {},
          onClose: () => {},
        })
      );

      assert.ok(html.includes('Carlos Mendoza'), 'Customer name in context panel');
      assert.ok(html.includes('+51 987 654 321'), 'Customer phone rendered');
      assert.ok(html.includes('get_product_stock'), 'Agent tool trace function rendered');
      assert.ok(html.includes('#ORD-8831'), 'Customer active order rendered');
      assert.ok(html.includes('$180.00 USD'), 'Customer order total rendered');
      assert.ok(html.includes('Cliente interesado en compra por volumen'), 'Internal note content rendered');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: CAS Concurrency Guard & Atomic Takeover
  // --------------------------------------------------------------------------
  describe('2. CAS Takeover Concurrency Guard', () => {
    it('displays visible CAS version tag in active chat header', () => {
      const chat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        stateVersion: 7,
      };

      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: chat,
          messages: [],
          activeSuggestion: null,
          composerText: '',
          onComposerTextChange: () => {},
          onSendMessage: () => {},
          onTakeover: () => {},
          onAcceptSuggestion: () => {},
          onDismissSuggestion: () => {},
          onEditSuggestionInComposer: () => {},
          isContextPanelOpen: true,
          onToggleContextPanel: () => {},
        })
      );

      assert.ok(html.includes('CAS v7'), 'Header displays correct CAS version number');
      assert.ok(html.includes('Versión de concurrencia CAS: 7'), 'Aria label includes CAS version');
    });

    it('renders TakeoverButton when conversation status is ai_handling', () => {
      const chat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        status: 'ai_handling',
        stateVersion: 4,
      };

      const html = renderToStaticMarkup(
        React.createElement(TakeoverButton, {
          stateVersion: chat.stateVersion,
          isLoading: false,
          onTakeover: () => {},
        })
      );

      assert.ok(html.includes('Tomar control (Pausar IA)'), 'Takeover button label is visible');
      assert.ok(html.includes('versión actual CAS 4'), 'Takeover button aria-label reflects CAS version');
      assert.ok(!html.includes('disabled=""'), 'Takeover button is not disabled when idle');
    });

    it('renders TakeoverButton in loading state with spinner and disabled attribute', () => {
      const html = renderToStaticMarkup(
        React.createElement(TakeoverButton, {
          stateVersion: 2,
          isLoading: true,
          onTakeover: () => {},
        })
      );

      assert.ok(html.includes('Tomando control...'), 'Displays loading text');
      assert.ok(html.includes('disabled=""'), 'Button is disabled while takeover is in flight');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Dynamic SLA Badges & Tricolor Calculation
  // --------------------------------------------------------------------------
  describe('3. Dynamic SLA Countdown & Tricolor Badges', () => {
    const fixedNow = 1700000000000;

    it('calculates NOMINAL state (Green) when remaining time > 5 minutes', () => {
      const slaDeadline = fixedNow + 18 * 60 * 1000; // 18 minutes remaining
      const badge = formatSlaBadge(slaDeadline, false, fixedNow);

      assert.strictEqual(badge.variant, 'green', 'Nominal variant is green');
      assert.strictEqual(badge.text, '18m', 'Displays minutes');
      assert.strictEqual(badge.isBreached, false, 'isBreached is false');
      assert.ok(badge.ariaLabel.includes('SLA en tiempo: restan 18 minutos'), 'Accessible text is correct');
    });

    it('calculates WARNING state (Amber) when remaining time is between 0 and 5 minutes', () => {
      const slaDeadline = fixedNow + 3 * 60 * 1000 + 25 * 1000; // 3m 25s remaining
      const badge = formatSlaBadge(slaDeadline, false, fixedNow);

      assert.strictEqual(badge.variant, 'amber', 'Warning variant is amber');
      assert.strictEqual(badge.text, '3m 25s', 'Displays minutes and seconds precision');
      assert.strictEqual(badge.isBreached, false, 'isBreached is false');
      assert.ok(badge.ariaLabel.includes('SLA en riesgo'), 'Accessible warning text is correct');
    });

    it('calculates BREACHED state (Red) when deadline has passed (diffMs <= 0)', () => {
      const slaDeadline = fixedNow - 7 * 60 * 1000; // 7 minutes overdue
      const badge = formatSlaBadge(slaDeadline, false, fixedNow);

      assert.strictEqual(badge.variant, 'red', 'Breached variant is red');
      assert.strictEqual(badge.text, '+7m breach', 'Displays overdue minutes with breach tag');
      assert.strictEqual(badge.isBreached, true, 'isBreached is true');
      assert.ok(badge.ariaLabel.includes('Alerta: SLA incumplido'), 'Accessible alert text is correct');
    });

    it('calculates BREACHED state (Red) when slaBreached flag is true even if deadline is future', () => {
      const slaDeadline = fixedNow + 10 * 60 * 1000;
      const badge = formatSlaBadge(slaDeadline, true, fixedNow);

      assert.strictEqual(badge.variant, 'red', 'Explicit slaBreached flag forces red variant');
      assert.strictEqual(badge.isBreached, true, 'isBreached is true');
    });

    it('renders ConversationCard with appropriate SLA accessibility role and classes', () => {
      // 1. Breached Card -> role="alert" + animate-pulse
      const breachedChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[1],
        slaBreached: true,
      };
      const breachedHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: breachedChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(breachedHtml.includes('role="alert"'), 'Breached badge has role="alert"');
      assert.ok(breachedHtml.includes('animate-pulse'), 'Breached badge has pulsating visual indicator');
      assert.ok(breachedHtml.includes('bg-red-100'), 'Breached badge uses red token');

      // 2. Warning Card -> role="status" + bg-amber-100
      const warningChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[2],
        slaDeadline: Date.now() + 2 * 60 * 1000,
        slaBreached: false,
      };
      const warningHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: warningChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(warningHtml.includes('role="status"'), 'Warning badge has role="status"');
      assert.ok(warningHtml.includes('bg-amber-100'), 'Warning badge uses amber token');

      // 3. Nominal Card -> role="status" + bg-emerald-100
      const nominalChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        slaDeadline: Date.now() + 20 * 60 * 1000,
        slaBreached: false,
      };
      const nominalHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: nominalChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(nominalHtml.includes('role="status"'), 'Nominal badge has role="status"');
      assert.ok(nominalHtml.includes('bg-emerald-100'), 'Nominal badge uses emerald token');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Meta 24-Hour Service Window Guard
  // --------------------------------------------------------------------------
  describe('4. Meta 24-Hour Service Window Guard', () => {
    it('renders ServiceWindowWarning and disables composer on expired WhatsApp chat', () => {
      const expiredWspChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[1],
        channel: 'whatsapp',
        is24hWindowActive: false,
      };

      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: expiredWspChat,
          messages: [],
          activeSuggestion: null,
          composerText: '',
          onComposerTextChange: () => {},
          onSendMessage: () => {},
          onTakeover: () => {},
          onAcceptSuggestion: () => {},
          onDismissSuggestion: () => {},
          onEditSuggestionInComposer: () => {},
          isContextPanelOpen: false,
          onToggleContextPanel: () => {},
        })
      );

      // Warning alert rendered
      assert.ok(html.includes('role="alert"'), 'ServiceWindowWarning alert rendered');
      assert.ok(html.includes('Ventana de 24h expirada'), 'Contains explanation of 24h policy');
      assert.ok(html.includes('Seleccionar Plantilla HSM'), 'Contains HSM template button');

      // Composer blocked
      assert.ok(html.includes('aria-disabled="true"'), 'Textarea has aria-disabled="true"');
      assert.ok(html.includes('disabled=""'), 'Textarea has disabled attribute');
      assert.ok(
        html.includes('placeholder="Ventana de 24h expirada'),
        'Placeholder indicates 24h window closed'
      );
    });

    it('enables composer and suppresses warning when WhatsApp window is active', () => {
      const activeWspChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        channel: 'whatsapp',
        is24hWindowActive: true,
      };

      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: activeWspChat,
          messages: [],
          activeSuggestion: null,
          composerText: '',
          onComposerTextChange: () => {},
          onSendMessage: () => {},
          onTakeover: () => {},
          onAcceptSuggestion: () => {},
          onDismissSuggestion: () => {},
          onEditSuggestionInComposer: () => {},
          isContextPanelOpen: false,
          onToggleContextPanel: () => {},
        })
      );

      assert.ok(!html.includes('Ventana de 24h expirada'), 'Warning is NOT displayed');
      assert.ok(!html.includes('aria-disabled="true"'), 'Composer is NOT disabled');
      assert.ok(html.includes('placeholder="Escribe un mensaje'), 'Standard placeholder displayed');
    });

    it('bypasses 24h window restriction for non-WhatsApp channels (Telegram, Webchat)', () => {
      // Even if is24hWindowActive is false, Telegram is not Meta Cloud API
      const telegramChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[2],
        channel: 'telegram',
        is24hWindowActive: false,
      };

      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: telegramChat,
          messages: [],
          activeSuggestion: null,
          composerText: '',
          onComposerTextChange: () => {},
          onSendMessage: () => {},
          onTakeover: () => {},
          onAcceptSuggestion: () => {},
          onDismissSuggestion: () => {},
          onEditSuggestionInComposer: () => {},
          isContextPanelOpen: false,
          onToggleContextPanel: () => {},
        })
      );

      assert.ok(!html.includes('Ventana de 24h expirada'), 'Telegram never displays Meta 24h warning');
      assert.ok(!html.includes('aria-disabled="true"'), 'Telegram composer is never blocked by Meta rule');
    });

    it('renders ServiceWindowWarning component standalone with alert role and Meta HSM picker button', () => {
      const html = renderToStaticMarkup(
        React.createElement(ServiceWindowWarning, {
          channel: 'whatsapp',
          is24hWindowActive: false,
          onOpenTemplatePicker: () => {},
        })
      );
      assert.ok(html.includes('role="alert"'), 'Direct ServiceWindowWarning has role="alert"');
      assert.ok(html.includes('Seleccionar Plantilla HSM'), 'HSM button is present');

      // Standalone validation of MOCK_MESSAGES fixture integrity
      assert.ok(Array.isArray(MOCK_MESSAGES['conv-wsp-01']), 'Mock messages exist for conv-wsp-01');
      assert.ok(MOCK_MESSAGES['conv-wsp-01'].length > 0, 'conv-wsp-01 has mock messages');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: AI Suggestion Banner & Quick Action Dispatch
  // --------------------------------------------------------------------------
  describe('5. AI Suggestion Banner & Keyboard Dispatch', () => {
    it('renders AiSuggestionBanner with confidence, reasoning notes, and sources', () => {
      const suggestion: AiSuggestionPayload = MOCK_AI_SUGGESTIONS['conv-wsp-01'];

      const html = renderToStaticMarkup(
        React.createElement(AiSuggestionBanner, {
          suggestion,
          onAccept: () => {},
          onEdit: () => {},
          onDismiss: () => {},
        })
      );

      assert.ok(html.includes('role="region"'), 'Banner has region role');
      assert.ok(html.includes('aria-live="polite"'), 'Banner has polite live region');
      assert.ok(html.includes('94% confianza'), 'Confidence percent rendered');
      assert.ok(html.includes(suggestion.replyText), 'Reply text rendered');
      assert.ok(html.includes(suggestion.reasoningNotes), 'Reasoning notes rendered');
      assert.ok(html.includes('Catálogo de Productos 2026'), 'Knowledge source rendered');
      assert.ok(html.includes('aria-keyshortcuts="Control+Enter"'), 'Keyboard shortcut attribute declared');
      assert.ok(html.includes('Ctrl+Enter'), 'Visual keyboard shortcut hint rendered');
    });

    it('suppresses AiSuggestionBanner when activeSuggestion is null', () => {
      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: MOCK_CONVERSATIONS[0],
          messages: [],
          activeSuggestion: null,
          composerText: '',
          onComposerTextChange: () => {},
          onSendMessage: () => {},
          onTakeover: () => {},
          onAcceptSuggestion: () => {},
          onDismissSuggestion: () => {},
          onEditSuggestionInComposer: () => {},
          isContextPanelOpen: false,
          onToggleContextPanel: () => {},
        })
      );

      assert.ok(!html.includes('Sugerencia IA'), 'No AI suggestion banner rendered');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Multimodal Message Stream & Bubble Roles
  // --------------------------------------------------------------------------
  describe('6. Multimodal Message Stream', () => {
    it('renders customer inbound message with accessible label and slate styling', () => {
      const msg: OmnichannelMessage = {
        id: 'msg-cust-1',
        conversationId: 'chat-1',
        senderType: 'customer',
        senderName: 'Carlos Mendoza',
        body: '¿Tienen entrega hoy?',
        timestamp: 1700000000000,
        status: 'read',
        channel: 'whatsapp',
      };

      const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: msg }));

      assert.ok(html.includes('<article'), 'Message rendered inside article tag');
      assert.ok(html.includes('Mensaje de cliente Carlos Mendoza'), 'Article aria-label specifies customer sender');
      assert.ok(html.includes('bg-slate-100'), 'Customer bubble has neutral slate background');
      assert.ok(html.includes('¿Tienen entrega hoy?'), 'Message text is present');
    });

    it('renders operator outbound message with delivery status checks', () => {
      const msg: OmnichannelMessage = {
        id: 'msg-op-1',
        conversationId: 'chat-1',
        senderType: 'operator',
        senderName: 'Ana Pérez',
        body: 'Sí, despachamos en 2 horas.',
        timestamp: 1700000000000,
        status: 'delivered',
        channel: 'whatsapp',
      };

      const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: msg }));

      assert.ok(html.includes('Mensaje de operador Ana Pérez'), 'Article aria-label specifies operator sender');
      assert.ok(html.includes('bg-teal-600'), 'Operator bubble has primary teal background');
      assert.ok(html.includes('aria-label="Entregado"'), 'Delivery status check is present');
    });

    it('renders AI agent message with Bot icon, model name, confidence, and trace ID', () => {
      const msg: OmnichannelMessage = {
        id: 'msg-ai-1',
        conversationId: 'chat-1',
        senderType: 'agent',
        senderName: 'Automat AI',
        body: 'Stock verificado: 15 unidades en almacén.',
        timestamp: 1700000000000,
        status: 'sent',
        channel: 'whatsapp',
        agentModelUsed: 'Gemini 1.5 Pro',
        agentConfidenceScore: 0.96,
        agentTraceId: 'tr-99881',
      };

      const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: msg }));

      assert.ok(html.includes('Gemini 1.5 Pro'), 'Agent model pill rendered');
      assert.ok(html.includes('96%'), 'Agent confidence score rendered');
      assert.ok(html.includes('Trace: tr-99881'), 'Agent trace ID rendered');
    });

    it('renders system event message with centered pill and status role', () => {
      const msg: OmnichannelMessage = {
        id: 'msg-sys-1',
        conversationId: 'chat-1',
        senderType: 'system',
        senderName: 'Sistema',
        body: 'Operador Ana Pérez tomó el control del chat.',
        timestamp: 1700000000000,
        status: 'sent',
        channel: 'whatsapp',
      };

      const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: msg }));

      assert.ok(html.includes('role="status"'), 'System message has role="status"');
      assert.ok(html.includes('Mensaje del sistema: Operador Ana Pérez'), 'System aria-label rendered');
    });

    it('renders retry button when outbound message has status failed', () => {
      const msg: OmnichannelMessage = {
        id: 'msg-fail-1',
        conversationId: 'chat-1',
        senderType: 'operator',
        senderName: 'Ana Pérez',
        body: 'Mensaje que no pudo entregarse.',
        timestamp: 1700000000000,
        status: 'failed',
        channel: 'whatsapp',
      };

      const html = renderToStaticMarkup(React.createElement(MessageBubble, { message: msg }));

      assert.ok(html.includes('Reintentar'), 'Retry text button rendered');
      assert.ok(
        html.includes('aria-label="Error al enviar mensaje. Presiona para reintentar."'),
        'Retry button accessible description rendered'
      );
    });
  });

  // --------------------------------------------------------------------------
  // Suite 7: WAI-ARIA Attributes & Roving Tabindex
  // --------------------------------------------------------------------------
  describe('7. WAI-ARIA Navigation & Keyboard Semantics', () => {
    it('applies roving tabindex to ChannelFilterTabs (0 for active, -1 for inactive)', () => {
      const html = renderToStaticMarkup(
        React.createElement(ChannelFilterTabs, {
          currentChannel: 'telegram',
          onSelectChannel: () => {},
        })
      );

      // Telegram tab has tabIndex="0" and aria-selected="true"
      assert.ok(
        html.includes('id="tab-channel-telegram" aria-selected="true" aria-controls="panel-conversation-queue" tabindex="0"'),
        'Selected tab has tabIndex=0'
      );

      // WhatsApp tab has tabIndex="-1" and aria-selected="false"
      assert.ok(
        html.includes('id="tab-channel-whatsapp" aria-selected="false" aria-controls="panel-conversation-queue" tabindex="-1"'),
        'Inactive tab has tabIndex=-1'
      );
    });

    it('renders composer with accessible keyboard hint and describedby association', () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageComposer, {
          value: 'Hola mundo',
          onChange: () => {},
          onSend: () => {},
        })
      );

      assert.ok(html.includes('aria-describedby="composer-keyboard-hint"'), 'Textarea references hint ID');
      assert.ok(html.includes('id="composer-keyboard-hint"'), 'Hidden hint element exists with ID');
      assert.ok(html.includes('Presiona Enter para enviar o Shift+Enter para salto de línea'), 'Hint explains shortcuts');
    });
  });
});
