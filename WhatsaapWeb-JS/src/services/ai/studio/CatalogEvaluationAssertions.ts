import type { EvalScenarioV1 } from '@whatsap-automat/contracts';
import { compileEvalTextPattern, SimulationInputError } from '../eval/AgentEvalService';
import { isBoundedText } from '../gateway/BoundedTextCompletion';

export interface CatalogEvaluationMeasurement {
  text: string;
  tools: string[];
  steps: number;
  latencyMs: number;
  costMicroUsd: number;
}
export interface CatalogEvaluationAssertion {
  id: string;
  check: (value: CatalogEvaluationMeasurement) => boolean;
}
const toolName = /^[a-z][A-Za-z0-9_.-]{0,127}$/;

export function catalogScenarioChecks(scenario: EvalScenarioV1): CatalogEvaluationAssertion[] {
  if (Object.keys(scenario.mockConversationState).length || !isBoundedText(scenario.mockInput) ||
      scenario.mockInput.length > 1024 || JSON.stringify(scenario.mockInput).length > 1536) {
    throw new SimulationInputError('Catalog scenarios require a bounded input and no fabricated conversation state');
  }
  const checks = [
    ...scenario.expectedTools.map((target, index) => ({ id: 'expected-tool-' + index, type: 'expected_tool_called', target })),
    ...scenario.forbiddenTools.map((target, index) => ({ id: 'forbidden-tool-' + index, type: 'forbidden_tool_not_called', target })),
    ...scenario.expectedTextPatterns.map((target, index) => ({ id: 'expected-text-' + index, type: 'expected_text_matched', target })),
    ...scenario.forbiddenTextPatterns.map((target, index) => ({ id: 'forbidden-text-' + index, type: 'forbidden_text_absent', target })),
    ...scenario.assertions,
  ];
  if (checks.length > 16 || !checks.some(({ type }) => type === 'expected_text_matched') ||
      !checks.some(({ type }) => type === 'expected_tool_called' || type === 'forbidden_tool_not_called') ||
      new Set(checks.map(({ id }) => id)).size !== checks.length || checks.some(({ id }) => !id || id.length > 128)) {
    throw new SimulationInputError('Catalog scenarios require unique bounded assertions, including expected text and tool evidence');
  }
  const expected = new Set(checks.filter(({ type }) => type === 'expected_tool_called').map(({ target }) => target));
  if (checks.some(({ type, target }) => type === 'forbidden_tool_not_called' && expected.has(target))) {
    throw new SimulationInputError('A scenario cannot both require and forbid the same tool');
  }
  return checks.map((assertion) => {
    const { id, type, target } = assertion;
    if (type === 'expected_tool_called' || type === 'forbidden_tool_not_called') {
      if (!target || !toolName.test(target)) throw new SimulationInputError('Tool assertions require a bounded tool name');
      return { id, check: ({ tools }: CatalogEvaluationMeasurement) => tools.includes(target) === (type === 'expected_tool_called') };
    }
    if (type === 'expected_text_matched' || type === 'forbidden_text_absent') {
      if (!target) throw new SimulationInputError('Text assertions require a pattern');
      const expression = compileEvalTextPattern(target);
      return { id, check: ({ text }: CatalogEvaluationMeasurement) => expression.matcher(text).find() === (type === 'expected_text_matched') };
    }
    const limit = 'expectedValue' in assertion ? assertion.expectedValue : undefined;
    if (!['max_steps', 'max_cost_micro_usd', 'max_latency_ms'].includes(type) ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
      throw new SimulationInputError('The catalog profile supports only text, tool, and nonnegative budget assertions');
    }
    return { id, check: (value: CatalogEvaluationMeasurement) =>
      (type === 'max_steps' ? value.steps : type === 'max_cost_micro_usd' ? value.costMicroUsd : value.latencyMs) <= limit };
  });
}
