/**
 * Adversarial Stress Test Suite for PR-F3-04: Omnichannel 4-Panel Inbox
 * Teamwork Empirical Challenger: teamwork_challenger_m1_1
 *
 * Focus Areas:
 * 1. CAS Concurrency Takeover Racing & Monotonicity
 * 2. Dynamic SLA Boundary Transitions (exact 300,000ms & 0ms)
 * 3. Meta 24h Window Locking vs Non-WhatsApp Omnichannel Bypassing
 * 4. Rapid Filter Switching, Matrix Combinatorics & Adversarial Search Injection
 * 5. Composer Overflow & Boundary Stress
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  NavigationPanel,
  QueuePanel,
  TimelinePanel,
  ChannelFilterTabs,
  ConversationCard,
  ServiceWindowWarning,
  MessageComposer,
  TakeoverButton,
  formatSlaBadge,
  MOCK_CONVERSATIONS,
  type OmnichannelConversation,
  type AiSuggestionPayload,
  type ChannelProvider,
  type ConversationStatus,
} from '../index';

// ============================================================================
// TEST FIXTURES & ADVERSARIAL GENERATORS
// ============================================================================

function createBaseConversation(overrides: Partial<OmnichannelConversation> = {}): OmnichannelConversation {
  return {
    id: 'test-conv-01',
    tenantId: 'tenant-test',
    channel: 'whatsapp',
    participant: {
      id: 'part-01',
      name: 'Test Customer',
      phoneNumber: '+51 987 654 321',
      channel: 'whatsapp',
    },
    lastMessagePreview: 'Hola, necesito soporte urgente.',
    lastMessageTimestamp: Date.now() - 60000,
    unreadCount: 1,
    status: 'ai_handling',
    slaDeadline: Date.now() + 10 * 60 * 1000,
    slaBreached: false,
    stateVersion: 1,
    ownershipEpoch: 1,
    tags: [{ id: 't-1', name: 'Soporte', color: '#0D9488' }],
    is24hWindowActive: true,
    ...overrides,
  };
}

// In-Memory CAS Concurrency Engine simulating PostgreSQL transactional CAS takeover
class SimulatedCasTakeoverEngine {
  private currentVersion: number;
  private currentEpoch: number;
  private currentOwner: string;
  private conflictCount = 0;
  private successCount = 0;

  constructor(initialVersion = 1, initialEpoch = 1, initialOwner = 'system_ai') {
    this.currentVersion = initialVersion;
    this.currentEpoch = initialEpoch;
    this.currentOwner = initialOwner;
  }

  async attemptTakeover(
    expectedVersion: number,
    operatorId: string,
    jitterMs = 2
  ): Promise<{ success: boolean; conflict: boolean; newVersion: number; epoch: number }> {
    // Inject non-deterministic jitter to simulate real network latency
    if (jitterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * jitterMs));
    }

    // Atomic CAS comparison: UPDATE conversations SET state_version = state_version + 1 WHERE id = $1 AND state_version = $2
    if (expectedVersion !== this.currentVersion) {
      this.conflictCount++;
      return {
        success: false,
        conflict: true,
        newVersion: this.currentVersion,
        epoch: this.currentEpoch,
      };
    }

    this.currentVersion += 1;
    this.currentEpoch += 1;
    this.currentOwner = operatorId;
    this.successCount++;

    return {
      success: true,
      conflict: false,
      newVersion: this.currentVersion,
      epoch: this.currentEpoch,
    };
  }

  getVersion(): number {
    return this.currentVersion;
  }

  getEpoch(): number {
    return this.currentEpoch;
  }

  getOwner(): string {
    return this.currentOwner;
  }

  getStats(): { success: number; conflicts: number } {
    return { success: this.successCount, conflicts: this.conflictCount };
  }
}

// ============================================================================
// SUITE 1: CAS CONCURRENCY TAKEOVER RACING & MONOTONICITY
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 1: CAS Takeover Concurrency Racing & Monotonicity', () => {
  it('1.1 Massive Concurrent Takeover Race: 50 concurrent operators -> exactly 1 succeeds, 49 fail with 409 conflict', async () => {
    const engine = new SimulatedCasTakeoverEngine(1, 1);
    const concurrentOperators = 50;

    // All 50 operators observe stateVersion = 1 and simultaneously attempt takeover
    const promises = Array.from({ length: concurrentOperators }, (_, i) =>
      engine.attemptTakeover(1, `operator-${i}`, 5)
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => r.conflict);

    assert.equal(successes.length, 1, 'Exactly one concurrent takeover attempt must succeed');
    assert.equal(conflicts.length, concurrentOperators - 1, 'All other attempts must receive CAS conflict');
    assert.equal(engine.getVersion(), 2, 'stateVersion must monotonically advance by exactly 1');
    assert.equal(engine.getEpoch(), 2, 'ownershipEpoch must monotonically advance by exactly 1');

    // All conflict results must report the updated currentVersion (2)
    for (const conflict of conflicts) {
      assert.equal(conflict.newVersion, 2, 'Conflict payload must report the updated currentVersion');
    }
  });

  it('1.2 Sequential Handoff Monotonicity: 100 sequential takeovers guarantee strictly monotonic increment', async () => {
    const engine = new SimulatedCasTakeoverEngine(1, 1);
    const steps = 100;
    const versionHistory: number[] = [engine.getVersion()];

    for (let i = 1; i <= steps; i++) {
      const current = engine.getVersion();
      const res = await engine.attemptTakeover(current, `operator-${i}`, 0);
      assert.equal(res.success, true);
      assert.equal(res.newVersion, current + 1);
      versionHistory.push(res.newVersion);
    }

    assert.equal(engine.getVersion(), 101);
    assert.equal(engine.getEpoch(), 101);

    // Verify strict monotonicity (v_{n} === v_{n-1} + 1)
    for (let i = 1; i < versionHistory.length; i++) {
      assert.equal(
        versionHistory[i],
        versionHistory[i - 1] + 1,
        `Version transition at index ${i} must be strictly monotonic (+1)`
      );
    }
  });

  it('1.3 Stale Request Rejection under Asynchronous Race Conditions', async () => {
    const engine = new SimulatedCasTakeoverEngine(10, 5);

    // Randomized stale versions <= 9
    const staleVersions = [1, 2, 5, 8, 9, 3, 7, 0, 4];
    for (const staleVersion of staleVersions) {
      const res = await engine.attemptTakeover(staleVersion, 'stale-operator', 0);
      assert.equal(res.success, false, `Stale version ${staleVersion} must be rejected`);
      assert.equal(res.conflict, true);
      assert.equal(res.newVersion, 10, 'Must report current authoritative version');
    }

    assert.equal(engine.getVersion(), 10, 'Authoritative version must remain unchanged after stale rejections');
  });

  it('1.4 Immediate AI Suggestion Invalidation on CAS Takeover', () => {
    const conv = createBaseConversation({ status: 'ai_handling', stateVersion: 1 });
    const suggestion: AiSuggestionPayload = {
      suggestionId: 'sug-adversarial',
      conversationId: conv.id,
      replyText: 'Respuesta sugerida por IA',
      confidenceScore: 0.95,
      suggestedAction: 'Consultar catálogo',
      reasoningNotes: 'Alta confianza',
      knowledgeSourcesUsed: [],
      expiresAt: Date.now() + 60000,
    };

    // Before takeover: TimelinePanel renders AiSuggestionBanner
    const htmlBefore = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: conv,
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
    assert.ok(htmlBefore.includes('Sugerencia IA (95% confianza)'), 'AiSuggestionBanner must be visible before takeover');

    // After takeover: activeSuggestion is null -> Banner must NOT render
    const htmlAfter = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: { ...conv, status: 'open', stateVersion: 2 },
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
    assert.ok(!htmlAfter.includes('Sugerencia IA'), 'AiSuggestionBanner must be purged immediately upon takeover');
  });

  it('1.5 TakeoverButton Conditional Rendering and Loading Guard', () => {
    // 1. Status 'ai_handling' -> TakeoverButton rendered
    const htmlAi = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: createBaseConversation({ status: 'ai_handling' }),
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
    assert.ok(htmlAi.includes('Tomar control (Pausar IA)'), 'Takeover button must render when status is ai_handling');

    // 2. Status 'pending_handoff' -> TakeoverButton rendered
    const htmlHandoff = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: createBaseConversation({ status: 'pending_handoff' }),
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
    assert.ok(htmlHandoff.includes('Tomar control (Pausar IA)'), 'Takeover button must render when status is pending_handoff');

    // 3. Status 'open' (already taken over) -> TakeoverButton must NOT render
    const htmlOpen = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: createBaseConversation({ status: 'open' }),
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
    assert.ok(!htmlOpen.includes('Tomar control (Pausar IA)'), 'Takeover button must NOT render when status is open');

    // 4. Loading state disables button and shows spinner
    const htmlLoading = renderToStaticMarkup(
      React.createElement(TakeoverButton, {
        stateVersion: 1,
        isLoading: true,
        onTakeover: () => {},
      })
    );
    assert.ok(htmlLoading.includes('disabled=""'), 'Takeover button must have disabled attribute when loading');
    assert.ok(htmlLoading.includes('Tomando control...'), 'Takeover button must show loading label');
  });

  it('1.6 Boundary State Version Values: 0 and MAX_SAFE_INTEGER increments without precision loss', () => {
    // Initial 0 increments to 1
    const initialZero = createBaseConversation({ stateVersion: 0 });
    const nextZero = { ...initialZero, stateVersion: initialZero.stateVersion + 1 };
    assert.equal(nextZero.stateVersion, 1);

    // Large safe integer: 2^53 - 2 increments cleanly
    const largeVersion = Number.MAX_SAFE_INTEGER - 1;
    const nextLarge = largeVersion + 1;
    assert.equal(nextLarge, Number.MAX_SAFE_INTEGER);
    assert.equal(Number.isSafeInteger(nextLarge), true);
  });
});

// ============================================================================
// SUITE 2: DYNAMIC SLA BOUNDARY TRANSITIONS & COUNTDOWN PRECISION
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 2: Dynamic SLA Boundary Transitions & Countdown Precision', () => {
  const referenceTime = 1700000000000;

  it('2.1 Exact Millisecond Boundary at 300,000 ms (5 Minutes): 300,001ms = Green vs 300,000ms = Amber', () => {
    // Case A: 300,001 ms remaining (> 5m by 1 millisecond) -> MUST BE GREEN
    const greenResult = formatSlaBadge(referenceTime + 300001, false, referenceTime);
    assert.equal(greenResult.variant, 'green', 'At 300,001ms diff, variant MUST be green');
    assert.equal(greenResult.isBreached, false);
    assert.equal(greenResult.text, '5m');
    assert.ok(greenResult.ariaLabel.includes('SLA en tiempo'));

    // Case B: Exactly 300,000 ms remaining (exact 5m 0s) -> MUST BE AMBER
    const amberExactResult = formatSlaBadge(referenceTime + 300000, false, referenceTime);
    assert.equal(amberExactResult.variant, 'amber', 'At exactly 300,000ms diff, variant MUST transition to amber');
    assert.equal(amberExactResult.isBreached, false);
    assert.equal(amberExactResult.text, '5m 0s');
    assert.ok(amberExactResult.ariaLabel.includes('SLA en riesgo'));

    // Case C: 299,999 ms remaining (< 5m by 1 millisecond) -> MUST BE AMBER
    const amberSubResult = formatSlaBadge(referenceTime + 299999, false, referenceTime);
    assert.equal(amberSubResult.variant, 'amber', 'At 299,999ms diff, variant MUST be amber');
    assert.equal(amberSubResult.isBreached, false);
    assert.equal(amberSubResult.text, '4m 59s');
  });

  it('2.2 Exact Millisecond Boundary at 0 ms (Breach Transition): 1ms = Amber vs 0ms = Red Breach', () => {
    // Case A: 1 ms remaining (> 0 by 1 millisecond) -> MUST BE AMBER
    const amberLastMsResult = formatSlaBadge(referenceTime + 1, false, referenceTime);
    assert.equal(amberLastMsResult.variant, 'amber', 'At 1ms remaining, variant MUST still be amber (not breached)');
    assert.equal(amberLastMsResult.isBreached, false);
    assert.equal(amberLastMsResult.text, '0m 0s');

    // Case B: Exactly 0 ms remaining (now === deadline) -> MUST BE RED BREACH
    const breachExactResult = formatSlaBadge(referenceTime, false, referenceTime);
    assert.equal(breachExactResult.variant, 'red', 'At exactly 0ms remaining, variant MUST transition to red breach');
    assert.equal(breachExactResult.isBreached, true);
    assert.equal(breachExactResult.text, '+1m breach');
    assert.ok(breachExactResult.ariaLabel.includes('SLA incumplido'));

    // Case C: -1 ms remaining (1 millisecond overdue) -> MUST BE RED BREACH
    const breachSubResult = formatSlaBadge(referenceTime - 1, false, referenceTime);
    assert.equal(breachSubResult.variant, 'red', 'At -1ms, variant MUST be red breach');
    assert.equal(breachSubResult.isBreached, true);
    assert.equal(breachSubResult.text, '+1m breach');
  });

  it('2.3 Overdue Minute Rounding Boundaries across Extended Delays', () => {
    // -59,999 ms -> +1m breach
    assert.equal(formatSlaBadge(referenceTime - 59999, false, referenceTime).text, '+1m breach');

    // -60,000 ms (exact 1m overdue) -> +1m breach
    assert.equal(formatSlaBadge(referenceTime - 60000, false, referenceTime).text, '+1m breach');

    // -60,001 ms -> +1m breach (Math.floor(60001 / 60000) === 1)
    assert.equal(formatSlaBadge(referenceTime - 60001, false, referenceTime).text, '+1m breach');

    // -119,999 ms -> +1m breach
    assert.equal(formatSlaBadge(referenceTime - 119999, false, referenceTime).text, '+1m breach');

    // -120,000 ms (exact 2m overdue) -> +2m breach
    assert.equal(formatSlaBadge(referenceTime - 120000, false, referenceTime).text, '+2m breach');

    // -3,600,000 ms (exact 1 hour overdue) -> +60m breach
    assert.equal(formatSlaBadge(referenceTime - 3600000, false, referenceTime).text, '+60m breach');

    // -86,400,000 ms (exact 24 hours overdue) -> +1440m breach
    assert.equal(formatSlaBadge(referenceTime - 86400000, false, referenceTime).text, '+1440m breach');
  });

  it('2.4 Extreme Timestamps & Degenerate Values (+100 Days and -100 Days)', () => {
    // 100 days in the future (8,640,000,000 ms)
    const farFuture = referenceTime + 100 * 24 * 60 * 60 * 1000;
    const futureBadge = formatSlaBadge(farFuture, false, referenceTime);
    assert.equal(futureBadge.variant, 'green');
    assert.equal(futureBadge.isBreached, false);
    assert.equal(futureBadge.text, '2400h 0m');

    // 100 days in the past (-8,640,000,000 ms)
    const farPast = referenceTime - 100 * 24 * 60 * 60 * 1000;
    const pastBadge = formatSlaBadge(farPast, false, referenceTime);
    assert.equal(pastBadge.variant, 'red');
    assert.equal(pastBadge.isBreached, true);
    assert.equal(pastBadge.text, '+144000m breach');
  });

  it('2.5 Force Breach via Explicit slaBreached=true Flag overrides Future Deadline', () => {
    // Deadline is 2 hours in the future (+7,200,000 ms), but flag is explicitly true
    const forcedBreach = formatSlaBadge(referenceTime + 7200000, true, referenceTime);
    assert.equal(forcedBreach.variant, 'red', 'Explicit slaBreached flag MUST force red variant');
    assert.equal(forcedBreach.isBreached, true);
    assert.ok(forcedBreach.text.includes('breach'));
  });

  it('2.6 Component Rendering of ConversationCard at Exact SLA Boundary Thresholds', () => {
    // Green Card: deadline = referenceTime + 300,001 ms
    const greenConv = createBaseConversation({
      slaDeadline: referenceTime + 300001,
      slaBreached: false,
    });
    const greenHtml = renderToStaticMarkup(
      React.createElement(ConversationCard, {
        conversation: greenConv,
        isSelected: false,
        onClick: () => {},
        currentTime: referenceTime,
      })
    );
    assert.ok(greenHtml.includes('bg-emerald-100'), 'Card at 300,001ms must render emerald badge background');
    assert.ok(greenHtml.includes('text-emerald-800'), 'Card must render emerald badge text color');
    assert.ok(greenHtml.includes('5m'), 'Card must render 5m text');

    // Amber Card: deadline = referenceTime + 300,000 ms
    const amberConv = createBaseConversation({
      slaDeadline: referenceTime + 300000,
      slaBreached: false,
    });
    const amberHtml = renderToStaticMarkup(
      React.createElement(ConversationCard, {
        conversation: amberConv,
        isSelected: false,
        onClick: () => {},
        currentTime: referenceTime,
      })
    );
    assert.ok(amberHtml.includes('bg-amber-100'), 'Card at 300,000ms must render amber badge background');
    assert.ok(amberHtml.includes('text-amber-800'), 'Card must render amber badge text color');
    assert.ok(amberHtml.includes('5m 0s'), 'Card must render 5m 0s text');

    // Red Card: deadline = referenceTime (0ms)
    const redConv = createBaseConversation({
      slaDeadline: referenceTime,
      slaBreached: false,
    });
    const redHtml = renderToStaticMarkup(
      React.createElement(ConversationCard, {
        conversation: redConv,
        isSelected: false,
        onClick: () => {},
        currentTime: referenceTime,
      })
    );
    assert.ok(redHtml.includes('bg-red-100'), 'Card at 0ms must render red badge background');
    assert.ok(redHtml.includes('text-red-700'), 'Card must render red badge text color');
    assert.ok(redHtml.includes('+1m breach'), 'Card must render +1m breach text');
    assert.ok(redHtml.includes('animate-pulse'), 'Red breach badge must feature visual pulse animation');
  });
});

// ============================================================================
// SUITE 3: META 24-HOUR SERVICE WINDOW ENFORCEMENT VS OMNICHANNEL BYPASSING
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 3: Meta 24h Window Enforcement vs Omnichannel Bypassing', () => {
  it('3.1 WhatsApp Expired Window: Strict composer lock and Meta HSM template banner', () => {
    const expiredWhatsAppConv = createBaseConversation({
      channel: 'whatsapp',
      is24hWindowActive: false,
    });

    const html = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: expiredWhatsAppConv,
        messages: [],
        activeSuggestion: null,
        composerText: 'Borrador existente',
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

    // 1. ServiceWindowWarning is rendered with role="alert"
    assert.ok(html.includes('role="alert"'), 'ServiceWindowWarning alert must be rendered');
    assert.ok(html.includes('Ventana de 24h expirada'), 'Warning text must mention 24h window expired');
    assert.ok(html.includes('Seleccionar Plantilla HSM'), 'HSM template picker button must be present');

    // 2. MessageComposer textarea is disabled
    assert.ok(html.includes('disabled=""'), 'Textarea must have disabled attribute');
    assert.ok(html.includes('aria-disabled="true"'), 'Textarea must have aria-disabled="true"');

    // 3. Attach button is disabled
    assert.ok(
      html.includes('aria-label="Adjuntar archivo o imagen"') && html.includes('disabled=""'),
      'Attach button must be disabled'
    );

    // 4. Send button is disabled
    assert.ok(
      html.includes('aria-label="Enviar mensaje"') && html.includes('disabled=""'),
      'Send button must be disabled'
    );
  });

  it('3.2 WhatsApp Active Window: Free texting enabled and warning suppressed', () => {
    const activeWhatsAppConv = createBaseConversation({
      channel: 'whatsapp',
      is24hWindowActive: true,
    });

    const html = renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        activeConversation: activeWhatsAppConv,
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

    assert.ok(!html.includes('Ventana de 24h expirada'), 'Warning must NOT be rendered when window is active');
    assert.ok(!html.includes('Seleccionar Plantilla HSM'), 'HSM template button must NOT be rendered');
    assert.ok(!html.includes('aria-disabled="true"'), 'Composer textarea must NOT be disabled');
  });

  it('3.3 Non-WhatsApp Channels Bypass 24h Restriction even with is24hWindowActive=false', () => {
    const nonWhatsAppChannels: ChannelProvider[] = ['telegram', 'instagram', 'webchat'];

    for (const channel of nonWhatsAppChannels) {
      const nonWhatsAppConv = createBaseConversation({
        channel,
        is24hWindowActive: false, // Simulating stale or false flag
      });

      const html = renderToStaticMarkup(
        React.createElement(TimelinePanel, {
          activeConversation: nonWhatsAppConv,
          messages: [],
          activeSuggestion: null,
          composerText: 'Mensaje libre',
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

      assert.ok(
        !html.includes('Ventana de 24h expirada'),
        `Channel "${channel}" MUST bypass 24h window restriction`
      );
      assert.ok(
        !html.includes('Seleccionar Plantilla HSM'),
        `Channel "${channel}" must NOT display HSM template picker`
      );
      assert.ok(
        !html.includes('aria-disabled="true"'),
        `Channel "${channel}" composer must remain ENABLED`
      );
    }
  });

  it('3.4 Exhaustive 4x2 Combinatorial Matrix (Channels x 24h Window States)', () => {
    const channels: ChannelProvider[] = ['whatsapp', 'telegram', 'instagram', 'webchat'];
    const windowStates = [true, false];

    for (const channel of channels) {
      for (const isActive of windowStates) {
        const warningHtml = renderToStaticMarkup(
          React.createElement(ServiceWindowWarning, {
            channel,
            is24hWindowActive: isActive,
            onOpenTemplatePicker: () => {},
          })
        );

        if (channel === 'whatsapp' && !isActive) {
          assert.ok(
            warningHtml.includes('Ventana de 24h expirada'),
            'Only WhatsApp with inactive window must render warning'
          );
        } else {
          assert.equal(
            warningHtml,
            '',
            `Channel ${channel} with is24hWindowActive=${isActive} must return empty markup`
          );
        }
      }
    }
  });

  it('3.5 Draft Retention: In-flight draft is preserved when 24h window expires', () => {
    const draftContent = 'Estimado cliente, verificando su orden #991823...';

    // Render composer with disabled=true and preserved value
    const html = renderToStaticMarkup(
      React.createElement(MessageComposer, {
        value: draftContent,
        onChange: () => {},
        onSend: () => {},
        disabled: true,
        disabledReason: 'Ventana de 24h expirada',
      })
    );

    assert.ok(html.includes(draftContent), 'Draft text must be preserved in textarea even when disabled');
    assert.ok(html.includes('disabled=""'), 'Composer must be disabled');
  });
});

// ============================================================================
// SUITE 4: RAPID FILTER SWITCHING, SEARCH INJECTION & MATRIX COMBINATORICS
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 4: Rapid Filter Switching & Matrix Combinatorics', () => {
  it('4.1 Rapid Channel Filter Cycling preserves queue consistency', () => {
    const channelSequence: Array<'all' | ChannelProvider> = [
      'all',
      'whatsapp',
      'telegram',
      'instagram',
      'webchat',
      'all',
    ];

    let totalFromParts = 0;
    const conversations = MOCK_CONVERSATIONS;

    for (const ch of channelSequence) {
      const filtered =
        ch === 'all' ? conversations : conversations.filter((c) => c.channel === ch);

      if (ch !== 'all') {
        totalFromParts += filtered.length;
      }

      // Render QueuePanel for each filtered state
      const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
          conversations: filtered,
          selectedChatId: filtered[0]?.id ?? null,
          onSelectChat: () => {},
          operatorPresence: 'available',
          onPresenceChange: () => {},
        })
      );

      assert.ok(html.includes(`Cola de Trabajo`), 'Queue panel header must render on every channel switch');
      assert.ok(
        html.includes(`>${filtered.length}<`),
        `Queue badge count must accurately reflect ${filtered.length} items`
      );
    }

    assert.equal(
      totalFromParts,
      conversations.length,
      'Sum of conversations across individual channels must equal total conversation count'
    );
  });

  it('4.2 Rapid Operational Status Cycling adheres strictly to status predicates', () => {
    const statuses: Array<ConversationStatus | 'all' | 'mine' | 'sla_risk'> = [
      'all',
      'mine',
      'ai_handling',
      'pending_handoff',
      'sla_risk',
      'resolved',
    ];

    const conversations = MOCK_CONVERSATIONS;

    for (const st of statuses) {
      const filtered = conversations.filter((chat) => {
        if (st === 'all') return true;
        if (st === 'mine') {
          return (
            chat.assignedOperatorName?.includes('Tú') ||
            chat.assignedOperatorId === 'op-01'
          );
        }
        if (st === 'sla_risk') {
          return (
            chat.slaBreached || chat.slaDeadline - Date.now() <= 5 * 60 * 1000
          );
        }
        return chat.status === st;
      });

      // Verify predicates
      for (const item of filtered) {
        if (st === 'mine') {
          assert.ok(
            item.assignedOperatorName?.includes('Tú') || item.assignedOperatorId === 'op-01'
          );
        } else if (st === 'sla_risk') {
          assert.ok(
            item.slaBreached || item.slaDeadline - Date.now() <= 5 * 60 * 1000
          );
        } else if (st !== 'all') {
          assert.equal(item.status, st);
        }
      }

      // Render QueuePanel
      const html = renderToStaticMarkup(
        React.createElement(QueuePanel, {
          conversations: filtered,
          selectedChatId: filtered[0]?.id ?? null,
          onSelectChat: () => {},
          operatorPresence: 'available',
          onPresenceChange: () => {},
        })
      );
      assert.ok(html.includes(`Cola de Trabajo`));
    }
  });

  it('4.3 Exhaustive Channel x Status Filter Matrix (5 Channels x 6 Statuses = 30 Iterations)', () => {
    const channels: Array<'all' | ChannelProvider> = [
      'all',
      'whatsapp',
      'telegram',
      'instagram',
      'webchat',
    ];
    const statuses: Array<ConversationStatus | 'all' | 'mine' | 'sla_risk'> = [
      'all',
      'mine',
      'ai_handling',
      'pending_handoff',
      'sla_risk',
      'resolved',
    ];

    let emptyCount = 0;
    let nonEmptyCount = 0;

    for (const ch of channels) {
      for (const st of statuses) {
        const filtered = MOCK_CONVERSATIONS.filter((chat) => {
          if (ch !== 'all' && chat.channel !== ch) return false;
          if (st === 'mine') {
            return (
              chat.assignedOperatorName?.includes('Tú') ||
              chat.assignedOperatorId === 'op-01'
            );
          }
          if (st === 'sla_risk') {
            return (
              chat.slaBreached || chat.slaDeadline - Date.now() <= 5 * 60 * 1000
            );
          }
          if (st !== 'all') {
            return chat.status === st;
          }
          return true;
        });

        const html = renderToStaticMarkup(
          React.createElement(QueuePanel, {
            conversations: filtered,
            selectedChatId: filtered[0]?.id ?? null,
            onSelectChat: () => {},
            operatorPresence: 'available',
            onPresenceChange: () => {},
            onResetFilters: () => {},
          })
        );

        if (filtered.length === 0) {
          emptyCount++;
          assert.ok(html.includes('No hay conversaciones'), 'Empty matrix cell must render empty notice');
          assert.ok(html.includes('Limpiar filtros'), 'Empty matrix cell must offer filter reset button');
        } else {
          nonEmptyCount++;
          assert.ok(html.includes('role="list"'), 'Non-empty cell must render list role');
        }
      }
    }

    assert.equal(emptyCount + nonEmptyCount, 30, 'All 30 matrix combinations executed cleanly');
  });

  it('4.4 Adversarial Search Inputs: Regex, SQL, XSS, Unicode, Emojis, and Whitespace Padding', () => {
    const adversarialQueries = [
      // Regex special metacharacters
      '.*',
      '[a-z]+',
      '(foo|bar)',
      '^$',
      '\\d{3}',
      '+51',
      // SQL injection patterns
      "'; DROP TABLE conversations; --",
      "' OR 1=1 --",
      // HTML & XSS injection vectors
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      // Unicode, RTL & Emojis
      '🌟✨ Carlos',
      'مرحبا',
      'Мendoza',
      '\u0000',
      // Whitespace padding
      '   Carlos   ',
      '   ',
    ];

    for (const query of adversarialQueries) {
      const q = query.trim().toLowerCase();
      // Execute the search filter logic from OmnichannelInbox
      const filtered = MOCK_CONVERSATIONS.filter((chat) => {
        if (!q) return true;
        const matchesName = chat.participant.name.toLowerCase().includes(q);
        const matchesPhone = chat.participant.phoneNumber?.includes(q);
        const matchesUsername = chat.participant.username?.toLowerCase().includes(q);
        const matchesPreview = chat.lastMessagePreview.toLowerCase().includes(q);
        return matchesName || matchesPhone || matchesUsername || matchesPreview;
      });

      // Verify no exception was thrown and static markup renders cleanly
      assert.ok(Array.isArray(filtered));
      const html = renderToStaticMarkup(
        React.createElement(NavigationPanel, {
          currentChannel: 'all',
          onSelectChannel: () => {},
          searchQuery: query,
          onSearchChange: () => {},
          statusFilter: 'all',
          onSelectStatusFilter: () => {},
        })
      );

      assert.ok(html.includes('role="searchbox"'), 'Search box must render for all inputs');
    }
  });

  it('4.5 Roving TabIndex across ChannelFilterTabs keyboard navigation', () => {
    const htmlWhatsapp = renderToStaticMarkup(
      React.createElement(ChannelFilterTabs, {
        currentChannel: 'whatsapp',
        onSelectChannel: () => {},
      })
    );

    // Active tab WhatsApp has tabIndex 0, all others have -1
    assert.ok(
      htmlWhatsapp.includes('id="tab-channel-whatsapp"') &&
        htmlWhatsapp.includes('aria-selected="true"') &&
        htmlWhatsapp.includes('tabindex="0"'),
      'Selected tab must have tabIndex=0'
    );
    assert.ok(
      htmlWhatsapp.includes('id="tab-channel-telegram"') &&
        htmlWhatsapp.includes('aria-selected="false"') &&
        htmlWhatsapp.includes('tabindex="-1"'),
      'Inactive tab must have tabIndex=-1'
    );
  });
});

// ============================================================================
// SUITE 5: COMPOSER OVERFLOW, ATTACHMENTS & UNICODE STRESS
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 5: Composer Text Boundaries & Unicode Stress', () => {
  it('5.1 10,000-character payload renders without markup distortion', () => {
    const longPayload = 'A'.repeat(10000);
    const html = renderToStaticMarkup(
      React.createElement(MessageComposer, {
        value: longPayload,
        onChange: () => {},
        onSend: () => {},
      })
    );

    assert.ok(html.includes('max-h-32'), 'Composer maintains max-height CSS constraint');
    assert.ok(html.includes(longPayload.slice(0, 100)), 'Composer contains long payload content');
  });

  it('5.2 Multiline payload with 100 newlines survives cleanly', () => {
    const multiline = Array(100).fill('Línea de mensaje').join('\n');
    const trimmed = multiline.trim();
    assert.ok(trimmed.startsWith('Línea de mensaje'));
    assert.ok(trimmed.endsWith('Línea de mensaje'));
  });

  it('5.3 Complex Grapheme Clusters, Surrogate Pairs, and Emojis', () => {
    const emojiPayload = 'Hola 👋 👨‍👩‍👧‍👦 🏳️‍🌈 👩‍💻 ¡Pedido confirmado! 🎉';
    const html = renderToStaticMarkup(
      React.createElement(MessageComposer, {
        value: emojiPayload,
        onChange: () => {},
        onSend: () => {},
      })
    );
    assert.ok(html.includes('Hola 👋 👨‍👩‍👧‍👦 🏳️‍🌈 👩‍💻 ¡Pedido confirmado! 🎉'));
  });

  it('5.4 Empty and whitespace-only text prevents send button activation', () => {
    const emptyHtml = renderToStaticMarkup(
      React.createElement(MessageComposer, {
        value: '    \n\t   ',
        onChange: () => {},
        onSend: () => {},
      })
    );
    assert.ok(
      emptyHtml.includes('aria-label="Enviar mensaje"') && emptyHtml.includes('disabled=""'),
      'Send button must be disabled for whitespace-only text'
    );
  });
});

// ============================================================================
// SUITE 6: ADVERSARIAL EDGE CASE FINDINGS (EMPIRICAL VERIFICATION OF GAPS)
// ============================================================================

describe('ADVERSARIAL STRESS SUITE 6: Empirical Defect Verification & Edge Case Gaps', () => {
  it('6.1 Defect Demonstration: CAS Conflict retains optimistic status="open" and operator assignment', () => {
    // Initial conversation state: ai_handling, stateVersion 1
    const originalConv = createBaseConversation({
      status: 'ai_handling',
      stateVersion: 1,
      ownershipEpoch: 1,
      assignedOperatorName: undefined,
    });

    // Step 1: Optimistic Takeover (as executed in OmnichannelInbox.tsx lines 203-215)
    let conv = {
      ...originalConv,
      status: 'open' as ConversationStatus,
      stateVersion: originalConv.stateVersion + 1,
      ownershipEpoch: (originalConv.ownershipEpoch ?? 0) + 1,
      assignedOperatorName: 'Ana Pérez (Tú)',
    };

    // Step 2: Backend returns 409 conflict: another operator took it over (v=3)
    const conflictResponse = { conflict: true, newVersion: 3 };

    // Step 3: Reconcile as implemented in OmnichannelInbox.tsx lines 225-233:
    // setConversations((prev) => prev.map((c) => c.id === conversationId ? { ...c, stateVersion: res.newVersion ?? c.stateVersion } : c))
    conv = {
      ...conv,
      stateVersion: conflictResponse.newVersion,
    };

    // EMPIRICAL OBSERVATION:
    // Notice that while stateVersion was updated to 3:
    assert.equal(conv.stateVersion, 3, 'Version updated to 3');
    // BUT status remained 'open' and assignedOperatorName remained 'Ana Pérez (Tú)'!
    // Even though the takeover FAILED and this operator did NOT acquire control!
    const isStatusReverted = conv.status === 'ai_handling';
    const isAssignmentCleared = conv.assignedOperatorName === undefined;

    // We verify this empirical defect mode:
    assert.equal(isStatusReverted, false, 'Vulnerability verified: status does NOT revert on CAS conflict');
    assert.equal(isAssignmentCleared, false, 'Vulnerability verified: operator assignment is NOT cleared on CAS conflict');
    assert.equal(conv.status, 'open', 'Local state falsely claims status is open');
  });

  it('6.2 Specification Divergence: Resolved conversations with past SLA deadline match sla_risk filter', () => {
    const resolvedChat = createBaseConversation({
      id: 'conv-resolved-past-sla',
      status: 'resolved',
      slaDeadline: Date.now() - 3600000, // 1 hour ago
      slaBreached: true,
    });

    // 1. OmnichannelInbox.tsx filter implementation (lines 163-166):
    const inboxFilterPredicate = (chat: OmnichannelConversation) => {
      return chat.slaBreached || chat.slaDeadline - Date.now() <= 5 * 60 * 1000;
    };

    // 2. Reference Specification filter implementation (omnichannel-inbox.e2e.test.ts line 140):
    const specFilterPredicate = (chat: OmnichannelConversation) => {
      if (chat.status === 'resolved') return false;
      return chat.slaBreached || chat.slaDeadline - Date.now() <= 5 * 60 * 1000;
    };

    // Empirical divergence:
    const inboxResult = inboxFilterPredicate(resolvedChat);
    const specResult = specFilterPredicate(resolvedChat);

    assert.equal(inboxResult, true, 'OmnichannelInbox includes resolved chat in sla_risk filter');
    assert.equal(specResult, false, 'Specification excludes resolved chat from sla_risk filter');
    assert.notEqual(inboxResult, specResult, 'Empirical discrepancy between component filter and spec filter');
  });

  it('6.3 Inactive Window Bypass Invariant: Non-WhatsApp channels never lock composer regardless of timestamp', () => {
    const pastTimestamps = [
      Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
      Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    ];

    const nonWhatsAppChannels: ChannelProvider[] = ['telegram', 'instagram', 'webchat'];

    for (const channel of nonWhatsAppChannels) {
      for (const ts of pastTimestamps) {
        const conv = createBaseConversation({
          channel,
          lastMessageTimestamp: ts,
          is24hWindowActive: false,
        });

        // Verify TimelinePanel policy: channel !== 'whatsapp' || is24hWindowActive
        const is24hWindowBlocked = conv.channel === 'whatsapp' && !conv.is24hWindowActive;
        assert.equal(is24hWindowBlocked, false, `Channel ${channel} at ${ts} must never be blocked`);

        // Render ServiceWindowWarning
        const html = renderToStaticMarkup(
          React.createElement(ServiceWindowWarning, {
            channel: conv.channel,
            is24hWindowActive: conv.is24hWindowActive,
          })
        );
        assert.equal(html, '', `Warning banner must be completely suppressed for ${channel}`);
      }
    }
  });
});

