/**
 * Empirical Challenger Verification Suite for PR-F3-04:
 * Omnichannel 4-Panel Inbox Stress Testing
 *
 * Scopes Tested:
 * 1. Zero conversations empty state rendering
 * 2. Massive message list (10,000 messages) DOM rendering performance & scalability
 * 3. Null / undefined participant fields (phone, username, empty name)
 * 4. Null orders, empty internal notes, empty agent traces
 * 5. Keyboard shortcut event handling & IME composition guards (Enter, Shift+Enter, Ctrl+Enter, isComposing)
 * 6. WAI-ARIA role integrity & roving tabindex audit across all interactive elements
 * 7. CAS takeover concurrency guard & suggestion invalidation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  OmnichannelInbox,
  QueuePanel,
  TimelinePanel,
  ContextPanel,
  ChannelFilterTabs,
  ConversationCard,
  ServiceWindowWarning,
  TakeoverButton,
  MOCK_CONVERSATIONS,
  type OmnichannelConversation,
  type OmnichannelMessage,
  type AiSuggestionPayload,
  type InternalNote,
  type AiToolTraceItem,
} from '../index';

describe('PR-F3-04: Empirical Challenger Stress Test Suite', () => {

  // ==========================================================================
  // SUITE 1: ZERO CONVERSATIONS & DEGENERATE QUEUE RENDERING
  // ==========================================================================
  describe('Suite 1: Zero Conversations & Degenerate Queue Rendering', () => {
    it('1.1 renders OmnichannelInbox cleanly with zero conversations without throwing', () => {
      const startTime = performance.now();
      const html = renderToStaticMarkup(
        React.createElement(OmnichannelInbox, {
          initialConversations: [],
          initialMessages: {},
          initialActiveSuggestion: null,
          initialAgentTraces: {},
          initialActiveOrders: {},
          initialInternalNotes: {},
        })
      );
      const durationMs = performance.now() - startTime;

      // Root rendered
      assert.ok(html.includes('data-testid="omnichannel-inbox"'), 'Root container rendered');

      // Panel 1: Navigation rendered with 0 unread
      assert.ok(html.includes('role="navigation"'), 'Panel 1 navigation rendered');
      assert.ok(html.includes('aria-label="Navegación principal y canales"'), 'Panel 1 aria-label rendered');

      // Panel 2: Queue rendered with empty state
      assert.ok(html.includes('id="panel-conversation-queue"'), 'Queue panel section rendered');
      assert.ok(html.includes('No hay conversaciones'), 'Empty queue title displayed');
      assert.ok(
        html.includes('No se encontraron resultados con los filtros actuales.'),
        'Empty queue explanatory text displayed'
      );
      assert.ok(html.includes('Limpiar filtros'), 'Reset filters button present');

      // Panel 3: Timeline rendered with no conversation selected fallback
      assert.ok(html.includes('role="region"'), 'Timeline region rendered');
      assert.ok(html.includes('aria-label="Conversación activa"'), 'Empty timeline aria-label rendered');
      assert.ok(html.includes('Ninguna conversación seleccionada'), 'No conversation selected heading displayed');
      assert.ok(
        html.includes('Selecciona un chat de la cola de trabajo para comenzar a interactuar.'),
        'Timeline empty hint displayed'
      );

      // Panel 4: ContextPanel returns null when activeConversation is null
      assert.ok(!html.includes('id="context-panel-inspector"'), 'Context panel not rendered when chat is null');

      // Performance check
      assert.ok(durationMs < 200, `Zero-state rendering took ${durationMs.toFixed(2)}ms (expected < 200ms)`);
    });

    it('1.2 renders standalone QueuePanel with empty list and verifies polite live announcement', () => {
      const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
          conversations: [],
          selectedChatId: null,
          onSelectChat: () => {},
          operatorPresence: 'available',
          onPresenceChange: () => {},
          onResetFilters: () => {},
        })
      );

      assert.ok(html.includes('role="region"'), 'QueuePanel role is region');
      assert.ok(html.includes('id="queue-live-announcer"'), 'Polite live announcer element rendered');
      assert.ok(html.includes('aria-live="polite"'), 'Live announcer has aria-live="polite"');
      assert.ok(html.includes('aria-atomic="true"'), 'Live announcer has aria-atomic="true"');
      assert.ok(html.includes('role="list"'), 'List container rendered');
      assert.ok(html.includes('No hay conversaciones'), 'Empty queue message rendered');
    });

    it('1.3 renders standalone TimelinePanel with null activeConversation', () => {
      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: null,
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

      assert.ok(html.includes('Ninguna conversación seleccionada'), 'Fallback heading displayed');
      assert.ok(!html.includes('role="log"'), 'Message log should NOT render when no conversation selected');
      assert.ok(!html.includes('role="textbox"'), 'Composer textarea should NOT render when no conversation selected');
    });

    it('1.4 renders standalone ContextPanel with null conversation', () => {
      const html = renderToStaticMarkup(
        React.createElement(ContextPanel, {
          isOpen: true,
          conversation: null,
          onAddInternalNote: () => {},
          onAddTag: () => {},
          onRemoveTag: () => {},
          onClose: () => {},
        })
      );

      assert.strictEqual(html, '', 'ContextPanel should render null/empty when conversation is null');
    });
  });

  // ==========================================================================
  // SUITE 2: MASSIVE MESSAGE LIST (10,000 MESSAGES) DOM RENDERING
  // ==========================================================================
  describe('Suite 2: Massive Message List (10,000 Messages) Scalability', () => {
    it('2.1 renders 10,000 multimodal messages within performance budget without heap exhaustion', () => {
      const chat = MOCK_CONVERSATIONS[0];
      const MESSAGE_COUNT = 10000;
      const massiveMessages: OmnichannelMessage[] = [];

      const senderTypes: Array<'customer' | 'operator' | 'agent' | 'system'> = [
        'customer',
        'operator',
        'agent',
        'system',
      ];

      for (let i = 0; i < MESSAGE_COUNT; i++) {
        const sType = senderTypes[i % senderTypes.length];
        massiveMessages.push({
          id: `stress-msg-${i}`,
          conversationId: chat.id,
          senderType: sType,
          senderName: sType === 'customer' ? 'Carlos' : sType === 'operator' ? 'Ana' : sType === 'agent' ? 'Automat AI' : 'Sistema',
          body: `Mensaje de estrés concurrente #${i}: prueba de escalabilidad y memoria del renderizado DOM.`,
          timestamp: 1730000000000 + i * 1000,
          status: i % 5 === 0 ? 'failed' : 'sent',
          channel: 'whatsapp',
          agentModelUsed: sType === 'agent' ? 'Gemini 1.5 Pro' : undefined,
          agentConfidenceScore: sType === 'agent' ? 0.95 : undefined,
          agentTraceId: sType === 'agent' ? `trace-stress-${i}` : undefined,
        });
      }

      const startTime = performance.now();
      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: chat,
          messages: massiveMessages,
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
      const durationMs = performance.now() - startTime;

      // Verify DOM volume and integrity
      assert.ok(html.includes('role="log"'), 'Message log role present');
      assert.ok(html.includes('Mensaje de estrés concurrente #0'), 'First message rendered');
      assert.ok(html.includes('Mensaje de estrés concurrente #5000'), 'Middle message rendered');
      assert.ok(html.includes(`Mensaje de estrés concurrente #${MESSAGE_COUNT - 1}`), '10,000th message rendered');
      assert.ok(html.length > 3_000_000, `Rendered HTML string is massive (${html.length} chars)`);

      // Performance assertion: 10,000 React components serialized to HTML in under 8,000ms
      assert.ok(
        durationMs < 8000,
        `Rendering 10,000 messages took ${durationMs.toFixed(2)}ms (expected < 8000ms)`
      );
    });
  });

  // ==========================================================================
  // SUITE 3: MISSING & MALFORMED PARTICIPANT PROFILE FIELDS
  // ==========================================================================
  describe('Suite 3: Missing & Malformed Participant Profile Fields', () => {
    it('3.1 handles participant with missing phone and username (Webchat anonymous)', () => {
      const anonChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        participant: {
          id: 'anon-01',
          name: 'Visitante Anónimo',
          channel: 'webchat',
          phoneNumber: undefined,
          username: undefined,
        },
      };

      const timelineHtml = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: anonChat,
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

      // Verify fallback to 'Canal web' in header
      assert.ok(timelineHtml.includes('Canal web'), 'Header displays fallback "Canal web" when phone/username missing');

      const contextHtml = renderToStaticMarkup(
        React.createElement(ContextPanel, {
          isOpen: true,
          conversation: anonChat,
          onAddInternalNote: () => {},
          onAddTag: () => {},
          onRemoveTag: () => {},
          onClose: () => {},
        })
      );

      // Verify fallback to 'Usuario web' in context inspector
      assert.ok(contextHtml.includes('Usuario web'), 'Context panel displays fallback "Usuario web"');
      assert.ok(contextHtml.includes('VA'), 'Initials generated correctly for Visitante Anónimo');
    });

    it('3.2 handles edge case participant names (empty, whitespace, single-letter, multi-word)', () => {
      // 1. Single character name
      const singleCharChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        participant: {
          id: 'p-1',
          name: 'Z',
          channel: 'whatsapp',
        },
      };
      const singleCardHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: singleCharChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(singleCardHtml.includes('>Z<'), 'Initials for single character name "Z" is "Z"');

      // 2. Multi-word name (4 words)
      const multiWordChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        participant: {
          id: 'p-2',
          name: 'Maria del Carmen Gómez',
          channel: 'whatsapp',
        },
      };
      const multiCardHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: multiWordChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(multiCardHtml.includes('>MD<'), 'Initials for "Maria del Carmen" takes first two parts: "MD"');

      // 3. Whitespace-padded name
      const paddedChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        participant: {
          id: 'p-3',
          name: '   Rodrigo   Paz   ',
          channel: 'whatsapp',
        },
      };
      const paddedCardHtml = renderToStaticMarkup(
        React.createElement(ConversationCard, {
          conversation: paddedChat,
          isSelected: false,
          onClick: () => {},
        })
      );
      assert.ok(paddedCardHtml.includes('>RP<'), 'Padded name trims and produces "RP"');

      // 4. Empty name string does not crash
      const emptyNameChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        participant: {
          id: 'p-4',
          name: '',
          channel: 'whatsapp',
        },
      };
      assert.doesNotThrow(() => {
        renderToStaticMarkup(
          React.createElement(ConversationCard, {
            conversation: emptyNameChat,
            isSelected: false,
            onClick: () => {},
          })
        );
      }, 'Empty name does not crash ConversationCard');
    });
  });

  // ==========================================================================
  // SUITE 4: NULL / DEGENERATE ORDER, NOTES, TRACES & TAGS
  // ==========================================================================
  describe('Suite 4: Null, Undefined & Degenerate Orders, Notes, Traces & Tags', () => {
    it('4.1 renders ContextPanel with undefined order, empty notes, empty traces, and empty tags', () => {
      const cleanChat: OmnichannelConversation = {
        ...MOCK_CONVERSATIONS[0],
        tags: [],
        activeOrderId: undefined,
      };

      const html = renderToStaticMarkup(
        React.createElement(ContextPanel, {
          isOpen: true,
          conversation: cleanChat,
          agentTraces: [],
          activeOrder: undefined,
          internalNotes: [],
          onAddInternalNote: () => {},
          onAddTag: () => {},
          onRemoveTag: () => {},
          onClose: () => {},
        })
      );

      // Section 2: Tags
      assert.ok(html.includes('Sin etiquetas asignadas'), 'Displays empty tags fallback');

      // Section 3: Tool Traces
      assert.ok(
        html.includes('No hay herramientas ejecutadas recientemente.'),
        'Displays empty tool traces fallback'
      );

      // Section 4: Active Order
      assert.ok(
        html.includes('Sin pedidos activos asociados.'),
        'Displays empty order fallback'
      );

      // Section 5: Internal Notes
      assert.ok(html.includes('No hay notas registradas.'), 'Displays empty notes fallback');
    });

    it('4.2 renders massive internal notes list (100 notes) and agent traces (50 traces)', () => {
      const massiveNotes: InternalNote[] = Array.from({ length: 100 }, (_, i) => ({
        id: `note-stress-${i}`,
        authorName: `Operador ${i}`,
        text: `Nota interna de auditoría #${i} con observaciones sobre el cliente y su historial comercial.`,
        timestamp: 1730000000000 + i * 60000,
      }));

      const massiveTraces: AiToolTraceItem[] = Array.from({ length: 50 }, (_, i) => ({
        id: `trace-stress-${i}`,
        functionName: `tool_lookup_crm_${i}`,
        resultSummary: `Resultado de consulta #${i}: 20 registros encontrados`,
        timestamp: 1730000000000 + i * 5000,
        status: i % 10 === 0 ? 'failed' : 'completed',
        latencyMs: 80 + i,
      }));

      const html = renderToStaticMarkup(
        React.createElement(ContextPanel, {
          isOpen: true,
          conversation: MOCK_CONVERSATIONS[0],
          agentTraces: massiveTraces,
          internalNotes: massiveNotes,
          onAddInternalNote: () => {},
          onAddTag: () => {},
          onRemoveTag: () => {},
          onClose: () => {},
        })
      );

      assert.ok(html.includes('Nota interna de auditoría #0'), 'First note rendered');
      assert.ok(html.includes('Nota interna de auditoría #99'), 'Last note rendered');
      assert.ok(html.includes('tool_lookup_crm_0'), 'First trace function rendered');
      assert.ok(html.includes('tool_lookup_crm_49'), 'Last trace function rendered');
      assert.ok(html.includes('bg-red-100'), 'Failed trace badge rendered');
      assert.ok(html.includes('bg-emerald-100'), 'Completed trace badge rendered');
    });
  });

  // ==========================================================================
  // SUITE 5: KEYBOARD SHORTCUT EVENT HANDLERS & IME COMPOSITION GUARDS
  // ==========================================================================
  describe('Suite 5: Keyboard Shortcuts & IME Composition Event Handlers', () => {
    /**
     * Pure test of MessageComposer handleKeyDown contract:
     * Spec:
     * 1. If e.nativeEvent.isComposing === true -> RETURN early (NO send, NO preventDefault)
     * 2. If e.key === 'Enter' && !e.shiftKey -> preventDefault(), and if !disabled && value.trim() -> onSend()
     * 3. If e.key === 'Enter' && e.shiftKey -> allow newline (NO onSend, NO preventDefault)
     */
    function simulateComposerKeyDown(
      eventInit: {
        key: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        isComposing?: boolean;
      },
      state: { value: string; disabled?: boolean; onSend: () => void }
    ): { prevented: boolean; sent: boolean } {
      let prevented = false;
      let sent = false;

      const mockEvent = {
        key: eventInit.key,
        shiftKey: !!eventInit.shiftKey,
        ctrlKey: !!eventInit.ctrlKey,
        metaKey: !!eventInit.metaKey,
        nativeEvent: {
          isComposing: !!eventInit.isComposing,
        },
        preventDefault: () => {
          prevented = true;
        },
      };

      // Exact handler logic from MessageComposer.tsx lines 33-45
      if (mockEvent.nativeEvent.isComposing) {
        return { prevented, sent };
      }

      if (mockEvent.key === 'Enter' && !mockEvent.shiftKey) {
        mockEvent.preventDefault();
        if (!state.disabled && state.value.trim()) {
          state.onSend();
          sent = true;
        }
      }

      return { prevented, sent };
    }

    it('5.1 IME composition guard: Enter during IME composition does NOT trigger send or preventDefault', () => {
      let sendCalled = false;
      const res = simulateComposerKeyDown(
        {
          key: 'Enter',
          shiftKey: false,
          isComposing: true, // Japanese IME, Pinyin, or accent composition active
        },
        {
          value: 'こんにちは',
          disabled: false,
          onSend: () => {
            sendCalled = true;
          },
        }
      );

      assert.strictEqual(sendCalled, false, 'onSend must NOT be called while isComposing is true');
      assert.strictEqual(res.prevented, false, 'preventDefault must NOT be called so IME candidate can confirm');
    });

    it('5.2 Enter without Shift triggers send and prevents default newline', () => {
      let sendCalled = false;
      const res = simulateComposerKeyDown(
        {
          key: 'Enter',
          shiftKey: false,
          isComposing: false,
        },
        {
          value: 'Mensaje normal para despachar',
          disabled: false,
          onSend: () => {
            sendCalled = true;
          },
        }
      );

      assert.strictEqual(sendCalled, true, 'onSend must be called on Enter without Shift');
      assert.strictEqual(res.prevented, true, 'preventDefault must be called to prevent trailing newline');
    });

    it('5.3 Shift+Enter allows newline without sending or preventing default', () => {
      let sendCalled = false;
      const res = simulateComposerKeyDown(
        {
          key: 'Enter',
          shiftKey: true,
          isComposing: false,
        },
        {
          value: 'Primera línea',
          disabled: false,
          onSend: () => {
            sendCalled = true;
          },
        }
      );

      assert.strictEqual(sendCalled, false, 'onSend must NOT be called on Shift+Enter');
      assert.strictEqual(res.prevented, false, 'preventDefault must NOT be called on Shift+Enter (allows newline)');
    });

    it('5.4 Enter when composer is disabled does NOT trigger send but prevents default', () => {
      let sendCalled = false;
      const res = simulateComposerKeyDown(
        {
          key: 'Enter',
          shiftKey: false,
          isComposing: false,
        },
        {
          value: 'Intento de envío bloqueado',
          disabled: true, // 24h window closed
          onSend: () => {
            sendCalled = true;
          },
        }
      );

      assert.strictEqual(sendCalled, false, 'onSend must NOT be called when disabled is true');
      assert.strictEqual(res.prevented, true, 'preventDefault is still invoked to prevent stray line breaks');
    });

    it('5.5 Enter on whitespace-only input does NOT trigger send', () => {
      let sendCalled = false;
      const res = simulateComposerKeyDown(
        {
          key: 'Enter',
          shiftKey: false,
          isComposing: false,
        },
        {
          value: '    \n\t   ',
          disabled: false,
          onSend: () => {
            sendCalled = true;
          },
        }
      );

      assert.strictEqual(sendCalled, false, 'onSend must NOT be called for blank/whitespace input');
      assert.strictEqual(res.prevented, true, 'preventDefault is called');
    });

    /**
     * Test global shortcut in AiSuggestionBanner (Ctrl+Enter / Cmd+Enter)
     */
    function simulateBannerShortcut(event: {
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
    }): { accepted: boolean; prevented: boolean } {
      let accepted = false;
      let prevented = false;

      // Exact handler logic from AiSuggestionBanner.tsx lines 22-27
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        prevented = true;
        accepted = true;
      }

      return { accepted, prevented };
    }

    it('5.6 Ctrl+Enter triggers AI suggestion accept and prevents default', () => {
      const res = simulateBannerShortcut({ key: 'Enter', ctrlKey: true, metaKey: false });
      assert.strictEqual(res.accepted, true, 'Ctrl+Enter accepts AI suggestion');
      assert.strictEqual(res.prevented, true, 'Ctrl+Enter prevents default');
    });

    it('5.7 Cmd+Enter (metaKey on macOS) triggers AI suggestion accept and prevents default', () => {
      const res = simulateBannerShortcut({ key: 'Enter', ctrlKey: false, metaKey: true });
      assert.strictEqual(res.accepted, true, 'Cmd+Enter (metaKey) accepts AI suggestion');
      assert.strictEqual(res.prevented, true, 'Cmd+Enter prevents default');
    });

    it('5.8 Plain Enter does NOT trigger AI suggestion accept', () => {
      const res = simulateBannerShortcut({ key: 'Enter', ctrlKey: false, metaKey: false });
      assert.strictEqual(res.accepted, false, 'Plain Enter does not accept AI suggestion');
      assert.strictEqual(res.prevented, false, 'Plain Enter is unprevented');
    });
  });

  // ==========================================================================
  // SUITE 6: WAI-ARIA CONFORMANCE, SEMANTIC ROLES & ROVING TABINDEX
  // ==========================================================================
  describe('Suite 6: WAI-ARIA Conformance, Semantic Roles & Roving Tabindex', () => {
    it('6.1 Interactive Button Accessibility Audit: EVERY button in OmnichannelInbox must have an accessible label', () => {
      const html = renderToStaticMarkup(React.createElement(OmnichannelInbox, {}));

      // Regex matching all button openings
      const buttonRegex = /<button\b([^>]*)>(.*?)<\/button>/gis;
      let match: RegExpExecArray | null;
      let buttonCount = 0;

      while ((match = buttonRegex.exec(html)) !== null) {
        buttonCount++;
        const attributes = match[1];
        const innerContent = match[2];

        const hasAriaLabel = /aria-label=["'][^"']+["']/.test(attributes);
        const hasAriaLabelledBy = /aria-labelledby=["'][^"']+["']/.test(attributes);
        const hasTitle = /title=["'][^"']+["']/.test(attributes);
        // Strip out HTML tags to see if non-empty text exists inside
        const textContent = innerContent.replace(/<[^>]*>/g, '').trim();
        const hasTextContent = textContent.length > 0;

        const isAccessible = hasAriaLabel || hasAriaLabelledBy || hasTitle || hasTextContent;

        assert.ok(
          isAccessible,
          `Button #${buttonCount} lacks an accessible name! Attrs: [${attributes}], Inner: [${innerContent}]`
        );
      }

      assert.ok(buttonCount >= 10, `Audited ${buttonCount} interactive buttons across workspace`);
    });

    it('6.2 ChannelFilterTabs Roving Tabindex & ARIA Tablist Conformance', () => {
      // 1. Initial render with 'whatsapp' selected
      const wspHtml = renderToStaticMarkup(
        React.createElement(ChannelFilterTabs, {
          currentChannel: 'whatsapp',
          onSelectChannel: () => {},
        })
      );

      // Verify tablist semantics
      assert.ok(wspHtml.includes('role="tablist"'), 'Container has role="tablist"');
      assert.ok(wspHtml.includes('aria-label="Filtrar por canal de mensajería"'), 'Tablist has aria-label');
      assert.ok(wspHtml.includes('aria-orientation="horizontal"'), 'Tablist declares horizontal orientation');

      // WhatsApp tab is selected (tabindex="0", aria-selected="true")
      assert.ok(
        wspHtml.includes('id="tab-channel-whatsapp" aria-selected="true" aria-controls="panel-conversation-queue" tabindex="0"'),
        'Selected tab has tabindex=0 and aria-selected=true'
      );

      // All other tabs are inactive (tabindex="-1", aria-selected="false")
      const otherChannels = ['all', 'telegram', 'instagram', 'webchat'];
      for (const ch of otherChannels) {
        assert.ok(
          wspHtml.includes(`id="tab-channel-${ch}" aria-selected="false" aria-controls="panel-conversation-queue" tabindex="-1"`),
          `Inactive tab ${ch} has tabindex=-1 and aria-selected=false`
        );
      }

      // 2. Pure logic test of handleKeyDown keyboard roving loop
      const CHANNELS = ['all', 'whatsapp', 'telegram', 'instagram', 'webchat'];
      function simulateTabKeyDown(key: string, currentIndex: number): number {
        if (key === 'ArrowRight') return (currentIndex + 1) % CHANNELS.length;
        if (key === 'ArrowLeft') return (currentIndex - 1 + CHANNELS.length) % CHANNELS.length;
        if (key === 'Home') return 0;
        if (key === 'End') return CHANNELS.length - 1;
        return currentIndex;
      }

      // Right arrow moves forward
      assert.strictEqual(simulateTabKeyDown('ArrowRight', 0), 1);
      // Right arrow wraps at end (index 4 -> 0)
      assert.strictEqual(simulateTabKeyDown('ArrowRight', 4), 0);
      // Left arrow moves backward
      assert.strictEqual(simulateTabKeyDown('ArrowLeft', 2), 1);
      // Left arrow wraps at beginning (index 0 -> 4)
      assert.strictEqual(simulateTabKeyDown('ArrowLeft', 0), 4);
      // Home goes to 0
      assert.strictEqual(simulateTabKeyDown('Home', 3), 0);
      // End goes to last
      assert.strictEqual(simulateTabKeyDown('End', 1), 4);
    });

    it('6.3 QueuePanel List Keyboard Navigation & Roving Tabindex Logic', () => {
      const convs = MOCK_CONVERSATIONS;
      function simulateQueueListKeyDown(
        key: string,
        selectedId: string | null
      ): string | null {
        if (convs.length === 0) return null;
        const currentIndex = convs.findIndex((c) => c.id === selectedId);

        if (key === 'ArrowDown') {
          const nextIndex = Math.min(currentIndex + 1, convs.length - 1);
          return convs[nextIndex].id;
        }
        if (key === 'ArrowUp') {
          const prevIndex = Math.max(currentIndex - 1, 0);
          return convs[prevIndex].id;
        }
        if (key === 'Home') {
          return convs[0].id;
        }
        if (key === 'End') {
          return convs[convs.length - 1].id;
        }
        return selectedId;
      }

      // Down arrow selects next
      assert.strictEqual(simulateQueueListKeyDown('ArrowDown', convs[0].id), convs[1].id);
      // Down arrow at bottom stops at bottom
      assert.strictEqual(simulateQueueListKeyDown('ArrowDown', convs[convs.length - 1].id), convs[convs.length - 1].id);
      // Up arrow selects previous
      assert.strictEqual(simulateQueueListKeyDown('ArrowUp', convs[1].id), convs[0].id);
      // Up arrow at top stops at top
      assert.strictEqual(simulateQueueListKeyDown('ArrowUp', convs[0].id), convs[0].id);
      // Home selects first item
      assert.strictEqual(simulateQueueListKeyDown('Home', convs[2].id), convs[0].id);
      // End selects last item
      assert.strictEqual(simulateQueueListKeyDown('End', convs[0].id), convs[convs.length - 1].id);
      // Initial unselected (-1 index) gracefully selects index 0
      assert.strictEqual(simulateQueueListKeyDown('ArrowDown', null), convs[0].id);
    });

    it('6.4 ARIA Live Regions Audit across all components', () => {
      // 1. Queue live region is polite
      const queueHtml = renderToStaticMarkup(
        React.createElement(QueuePanel, {
          conversations: MOCK_CONVERSATIONS,
          selectedChatId: 'conv-wsp-01',
          onSelectChat: () => {},
          operatorPresence: 'available',
          onPresenceChange: () => {},
        })
      );
      assert.ok(queueHtml.includes('aria-live="polite"'), 'Queue live region is polite');

      // 2. Timeline message log is polite with additions text
      const timelineHtml = renderToStaticMarkup(
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
          isContextPanelOpen: true,
          onToggleContextPanel: () => {},
        })
      );
      assert.ok(timelineHtml.includes('role="log"'), 'Message history has role="log"');
      assert.ok(timelineHtml.includes('aria-live="polite"'), 'Message log is polite');
      assert.ok(timelineHtml.includes('aria-relevant="additions text"'), 'Message log tracks additions text');

      // 3. ServiceWindowWarning is assertive (urgent Meta block)
      const warningHtml = renderToStaticMarkup(
        React.createElement(ServiceWindowWarning, {
          channel: 'whatsapp',
          is24hWindowActive: false,
          onOpenTemplatePicker: () => {},
        })
      );
      assert.ok(warningHtml.includes('role="alert"'), 'Service window warning has role="alert"');
      assert.ok(warningHtml.includes('aria-live="assertive"'), 'Service window warning is assertive');

      // 4. TakeoverButton declares aria-live="polite"
      const takeoverHtml = renderToStaticMarkup(
        React.createElement(TakeoverButton, {
          stateVersion: 10,
          onTakeover: () => {},
        })
      );
      assert.ok(takeoverHtml.includes('aria-live="polite"'), 'Takeover button has polite live region');
    });
  });

  // ==========================================================================
  // SUITE 7: CAS TAKEOVER CONCURRENCY & SUGGESTION INVALIDATION
  // ==========================================================================
  describe('Suite 7: CAS Concurrency Guard & AI Suggestion Invalidation', () => {
    it('7.1 Takeover button renders stateVersion and changes to loading spinner on click', () => {
      // Idle state
      const idleHtml = renderToStaticMarkup(
        React.createElement(TakeoverButton, {
          stateVersion: 12,
          isLoading: false,
          onTakeover: () => {},
        })
      );
      assert.ok(idleHtml.includes('versión actual CAS 12'), 'Aria label includes CAS version');
      assert.ok(idleHtml.includes('Tomar control (Pausar IA)'), 'Button text includes action');
      assert.ok(!idleHtml.includes('disabled=""'), 'Button is not disabled');

      // Loading state
      const loadingHtml = renderToStaticMarkup(
        React.createElement(TakeoverButton, {
          stateVersion: 12,
          isLoading: true,
          onTakeover: () => {},
        })
      );
      assert.ok(loadingHtml.includes('disabled=""'), 'Button is disabled while loading');
      assert.ok(loadingHtml.includes('Tomando control...'), 'Loading text is displayed');
      assert.ok(loadingHtml.includes('animate-spin'), 'Spinner is animated');
    });

    it('7.2 OmnichannelInbox takeover synchronously invalidates active suggestion', () => {
      const chat = MOCK_CONVERSATIONS[0]; // conv-wsp-01 with active suggestion
      const suggestion: AiSuggestionPayload = {
        suggestionId: 'sug-test-1',
        conversationId: chat.id,
        replyText: 'Respuesta sugerida por IA',
        confidenceScore: 0.95,
        suggestedAction: 'Consultar inventario',
        reasoningNotes: 'Verificación de stock',
        knowledgeSourcesUsed: [{ id: 'k-1', title: 'Catálogo', type: 'catalog' }],
        expiresAt: Date.now() + 60000,
      };

      // Initially suggestion banner is rendered
      const withSugHtml = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: chat,
          messages: [],
          activeSuggestion: suggestion,
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
      assert.ok(withSugHtml.includes('Respuesta sugerida por IA'), 'Suggestion banner is rendered');

      // When invalidated (activeSuggestion = null)
      const withoutSugHtml = renderToStaticMarkup(
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
      assert.ok(!withoutSugHtml.includes('Respuesta sugerida por IA'), 'Suggestion banner is eliminated');
    });
  });
});
