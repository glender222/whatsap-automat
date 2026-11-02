import {
  calculateCostMicroUsd,
  formatMicroUsdToUsd,
  MODEL_RATE_CARDS,
  DEFAULT_RATE_CARD,
} from '@whatsap-automat/contracts';

export class CostCalculator {
  /**
   * Deterministic integer micro-USD computation.
   * 1 USD = 1,000,000 micro-USD.
   */
  public static calculate(model: string, promptTokens: number, completionTokens: number): number {
    return calculateCostMicroUsd(model, promptTokens, completionTokens);
  }

  /**
   * Formats integer micro-USD to standard USD decimal string (e.g. "12.45").
   */
  public static formatToUsd(costMicroUsd: number): string {
    return formatMicroUsdToUsd(costMicroUsd);
  }

  public static getRateCard(model: string) {
    return MODEL_RATE_CARDS[model] ?? DEFAULT_RATE_CARD;
  }
}
