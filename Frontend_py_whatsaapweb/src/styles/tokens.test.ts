/**
 * Automated Verification Suite for PR-F2-03:
 * Automat UI Design Tokens & WCAG 2.2 AA Contrast Compliance
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const TOKENS_CSS_PATH = path.resolve(__dirname, 'tokens.css');
const INDEX_CSS_PATH = path.resolve(__dirname, '../index.css');
const TAILWIND_CONFIG_PATH = path.resolve(__dirname, '../../tailwind.config.js');

// Helper: Parse CSS custom properties within a rule block
function parseTokenBlock(cssContent: string, selectorPattern: RegExp): Record<string, string> {
  const match = cssContent.match(selectorPattern);
  if (!match || !match[1]) {
    return {};
  }
  const blockBody = match[1];
  const tokenMap: Record<string, string> = {};
  const varRegex = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let varMatch: RegExpExecArray | null;
  while ((varMatch = varRegex.exec(blockBody)) !== null) {
    const key = varMatch[1].trim();
    // Strip inline comments e.g. /* ... */
    const value = varMatch[2].replace(/\/\*.*?\*\//g, '').trim();
    tokenMap[key] = value;
  }
  return tokenMap;
}

// Helper: Convert HEX color (#RGB or #RRGGBB) to linear RGB values
function hexToRgb(hex: string): [number, number, number] {
  let cleanHex = hex.trim().replace(/^#/, '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  if (cleanHex.length !== 6) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const num = parseInt(cleanHex, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return [r, g, b];
}

// WCAG relative luminance formula (sRGB to linear)
function calculateLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const transformChannel = (c: number): number => {
    const srgb = c / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  const rLin = transformChannel(r);
  const gLin = transformChannel(g);
  const bLin = transformChannel(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

// WCAG contrast ratio formula: (L1 + 0.05) / (L2 + 0.05)
function calculateContrastRatio(hex1: string, hex2: string): number {
  const l1 = calculateLuminance(hex1);
  const l2 = calculateLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('PR-F2-03: Automat UI Design Tokens & WCAG 2.2 AA Verification', () => {
  const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf-8');

  // Extract scopes
  const rootTokens = parseTokenBlock(tokensCss, /:root\s*\{([^}]+)\}/);
  const darkTokens = parseTokenBlock(tokensCss, /\.dark[^{]*\{([^}]+)\}/);
  const highContrastTokens = parseTokenBlock(tokensCss, /\.high-contrast[^{]*\{([^}]+)\}/);

  describe('1. Token Completeness across Themes', () => {
    it('defines all required semantic color tokens in :root (Light Theme)', () => {
      const requiredRootColors = [
        '--color-bg-canvas',
        '--color-bg-surface',
        '--color-bg-surface-elevated',
        '--color-border-subtle',
        '--color-border-strong',
        '--color-border-interactive',
        '--color-text-primary',
        '--color-text-secondary',
        '--color-text-muted',
        '--color-primary',
        '--color-primary-hover',
        '--color-primary-contrast',
        '--color-success',
        '--color-warning',
        '--color-danger',
        '--color-info',
        '--color-channel-whatsapp',
        '--color-channel-telegram',
        '--color-channel-instagram',
      ];

      for (const token of requiredRootColors) {
        assert.ok(rootTokens[token], `Missing color token in :root: ${token}`);
        assert.match(rootTokens[token], /^#[0-9a-fA-F]{6}$/i, `${token} should be a valid hex color, got "${rootTokens[token]}"`);
      }
    });

    it('defines all required Dark Theme color overrides in .dark / [data-theme="dark"]', () => {
      const requiredDarkColors = [
        '--color-bg-canvas',
        '--color-bg-surface',
        '--color-bg-surface-elevated',
        '--color-border-subtle',
        '--color-border-strong',
        '--color-border-interactive',
        '--color-text-primary',
        '--color-text-secondary',
        '--color-text-muted',
        '--color-primary',
        '--color-primary-hover',
        '--color-primary-contrast',
        '--color-success',
        '--color-warning',
        '--color-danger',
        '--color-info',
      ];

      for (const token of requiredDarkColors) {
        assert.ok(darkTokens[token], `Missing dark color token: ${token}`);
        assert.match(darkTokens[token], /^#[0-9a-fA-F]{6}$/i, `${token} in dark theme must be hex color`);
      }
    });

    it('defines High Contrast Theme tokens with high-visibility overrides', () => {
      const requiredHcColors = [
        '--color-bg-canvas',
        '--color-bg-surface',
        '--color-bg-surface-elevated',
        '--color-border-subtle',
        '--color-border-strong',
        '--color-border-interactive',
        '--color-text-primary',
        '--color-text-secondary',
        '--color-text-muted',
        '--color-primary',
        '--color-primary-hover',
        '--color-primary-contrast',
        '--color-success',
        '--color-warning',
        '--color-danger',
        '--color-info',
      ];

      for (const token of requiredHcColors) {
        assert.ok(highContrastTokens[token], `Missing high contrast token: ${token}`);
      }
      assert.equal(highContrastTokens['--color-bg-canvas'].toUpperCase(), '#000000');
      assert.equal(highContrastTokens['--color-bg-surface'].toUpperCase(), '#000000');
      assert.equal(highContrastTokens['--color-text-primary'].toUpperCase(), '#FFFFFF');
    });

    it('defines spacing, typography, density, radii, and z-index scales in :root', () => {
      // Spacing scale (4px / 8px)
      const expectedSpacing = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8'];
      for (const token of expectedSpacing) {
        assert.ok(rootTokens[token], `Missing spacing token: ${token}`);
      }

      // Density layout dimensions
      const expectedDensity = [
        '--height-chat-row',
        '--height-table-row',
        '--height-topbar',
        '--width-sidebar-collapsed',
        '--width-sidebar-expanded',
        '--width-inbox-queue',
        '--width-inbox-context',
        '--max-w-message-bubble',
      ];
      for (const token of expectedDensity) {
        assert.ok(rootTokens[token], `Missing density token: ${token}`);
      }

      // Radii
      const expectedRadii = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-full'];
      for (const token of expectedRadii) {
        assert.ok(rootTokens[token], `Missing radius token: ${token}`);
      }

      // Typography
      assert.ok(rootTokens['--font-sans'], 'Missing --font-sans');
      assert.ok(rootTokens['--font-mono'], 'Missing --font-mono');
    });

    it('defines WCAG 2.2 AA visible focus indicators in all themes', () => {
      assert.ok(rootTokens['--ring-focus-color'], 'Missing root --ring-focus-color');
      assert.ok(rootTokens['--ring-focus-width'], 'Missing root --ring-focus-width');
      assert.ok(rootTokens['--ring-focus-offset'], 'Missing root --ring-focus-offset');

      assert.ok(darkTokens['--ring-focus-color'], 'Missing dark --ring-focus-color');

      assert.ok(highContrastTokens['--ring-focus-color'], 'Missing high contrast --ring-focus-color');
      assert.ok(highContrastTokens['--ring-focus-width'], 'Missing high contrast --ring-focus-width');
    });
  });

  describe('2. WCAG 2.2 AA Contrast Compliance (Light Theme)', () => {
    it('verifies body/normal text achieves ratio >= 4.5:1 against light canvas & surface', () => {
      const canvas = rootTokens['--color-bg-canvas'];
      const surface = rootTokens['--color-bg-surface'];
      const textPrimary = rootTokens['--color-text-primary'];
      const textSecondary = rootTokens['--color-text-secondary'];
      const textMuted = rootTokens['--color-text-muted'];

      const ratioPrimaryCanvas = calculateContrastRatio(textPrimary, canvas);
      const ratioPrimarySurface = calculateContrastRatio(textPrimary, surface);
      const ratioSecondaryCanvas = calculateContrastRatio(textSecondary, canvas);
      const ratioSecondarySurface = calculateContrastRatio(textSecondary, surface);
      const ratioMutedSurface = calculateContrastRatio(textMuted, surface);

      assert.ok(ratioPrimaryCanvas >= 4.5, `Primary on canvas must be >= 4.5:1, got ${ratioPrimaryCanvas.toFixed(2)}`);
      assert.ok(ratioPrimarySurface >= 4.5, `Primary on surface must be >= 4.5:1, got ${ratioPrimarySurface.toFixed(2)}`);
      assert.ok(ratioSecondaryCanvas >= 4.5, `Secondary on canvas must be >= 4.5:1, got ${ratioSecondaryCanvas.toFixed(2)}`);
      assert.ok(ratioSecondarySurface >= 4.5, `Secondary on surface must be >= 4.5:1, got ${ratioSecondarySurface.toFixed(2)}`);
      assert.ok(ratioMutedSurface >= 4.5, `Muted on surface must be >= 4.5:1, got ${ratioMutedSurface.toFixed(2)}`);
    });

    it('verifies UI component borders and focus rings achieve ratio >= 3:1 against surface', () => {
      const surface = rootTokens['--color-bg-surface'];
      const borderInteractive = rootTokens['--color-border-interactive'];
      const focusRing = rootTokens['--ring-focus-color'];
      const primaryContrast = rootTokens['--color-primary-contrast'];
      const primary = rootTokens['--color-primary'];

      const ratioBorder = calculateContrastRatio(borderInteractive, surface);
      const ratioFocus = calculateContrastRatio(focusRing, surface);
      const ratioPrimaryButton = calculateContrastRatio(primaryContrast, primary);

      assert.ok(ratioBorder >= 3.0, `Interactive border must be >= 3.0:1 (WCAG 1.4.11), got ${ratioBorder.toFixed(2)}`);
      assert.ok(ratioFocus >= 3.0, `Focus ring must be >= 3.0:1 (WCAG 2.4.7 AA), got ${ratioFocus.toFixed(2)}`);
      assert.ok(ratioPrimaryButton >= 3.0, `Primary button text must be >= 3.0:1, got ${ratioPrimaryButton.toFixed(2)}`);
    });
  });

  describe('3. WCAG 2.2 AA Contrast Compliance (Dark Theme)', () => {
    it('verifies body text achieves ratio >= 4.5:1 against dark canvas & surface', () => {
      const canvas = darkTokens['--color-bg-canvas'];
      const surface = darkTokens['--color-bg-surface'];
      const textPrimary = darkTokens['--color-text-primary'];
      const textSecondary = darkTokens['--color-text-secondary'];

      const ratioPrimaryCanvas = calculateContrastRatio(textPrimary, canvas);
      const ratioPrimarySurface = calculateContrastRatio(textPrimary, surface);
      const ratioSecondaryCanvas = calculateContrastRatio(textSecondary, canvas);
      const ratioSecondarySurface = calculateContrastRatio(textSecondary, surface);

      assert.ok(ratioPrimaryCanvas >= 4.5, `Dark primary on canvas must be >= 4.5:1, got ${ratioPrimaryCanvas.toFixed(2)}`);
      assert.ok(ratioPrimarySurface >= 4.5, `Dark primary on surface must be >= 4.5:1, got ${ratioPrimarySurface.toFixed(2)}`);
      assert.ok(ratioSecondaryCanvas >= 4.5, `Dark secondary on canvas must be >= 4.5:1, got ${ratioSecondaryCanvas.toFixed(2)}`);
      assert.ok(ratioSecondarySurface >= 4.5, `Dark secondary on surface must be >= 4.5:1, got ${ratioSecondarySurface.toFixed(2)}`);
    });

    it('verifies UI component borders, focus rings, and CTA button text in dark theme', () => {
      const surface = darkTokens['--color-bg-surface'];
      const borderInteractive = darkTokens['--color-border-interactive'];
      const focusRing = darkTokens['--ring-focus-color'];
      const primaryContrast = darkTokens['--color-primary-contrast'];
      const primary = darkTokens['--color-primary'];

      const ratioBorder = calculateContrastRatio(borderInteractive, surface);
      const ratioFocus = calculateContrastRatio(focusRing, surface);
      const ratioPrimaryButton = calculateContrastRatio(primaryContrast, primary);

      assert.ok(ratioBorder >= 3.0, `Dark interactive border must be >= 3.0:1, got ${ratioBorder.toFixed(2)}`);
      assert.ok(ratioFocus >= 3.0, `Dark focus ring must be >= 3.0:1, got ${ratioFocus.toFixed(2)}`);
      assert.ok(ratioPrimaryButton >= 4.5, `Dark button text must be >= 4.5:1, got ${ratioPrimaryButton.toFixed(2)}`);
    });
  });

  describe('4. WCAG 2.2 AAA Contrast Compliance (High Contrast Theme)', () => {
    it('verifies High Contrast text achieves ratio >= 7:1 (AAA) against black background', () => {
      const canvas = highContrastTokens['--color-bg-canvas'];
      const surface = highContrastTokens['--color-bg-surface'];
      const textPrimary = highContrastTokens['--color-text-primary'];
      const textSecondary = highContrastTokens['--color-text-secondary'];
      const textMuted = highContrastTokens['--color-text-muted'];
      const primaryContrast = highContrastTokens['--color-primary-contrast'];
      const primary = highContrastTokens['--color-primary'];

      const ratioPrimaryCanvas = calculateContrastRatio(textPrimary, canvas);
      const ratioPrimarySurface = calculateContrastRatio(textPrimary, surface);
      const ratioSecondaryCanvas = calculateContrastRatio(textSecondary, canvas);
      const ratioMutedCanvas = calculateContrastRatio(textMuted, canvas);
      const ratioPrimaryButton = calculateContrastRatio(primaryContrast, primary);

      assert.ok(ratioPrimaryCanvas >= 7.0, `HC primary text on canvas must be >= 7:1 (AAA), got ${ratioPrimaryCanvas.toFixed(2)}`);
      assert.ok(ratioPrimarySurface >= 7.0, `HC primary text on surface must be >= 7:1 (AAA), got ${ratioPrimarySurface.toFixed(2)}`);
      assert.ok(ratioSecondaryCanvas >= 7.0, `HC secondary text must be >= 7:1 (AAA), got ${ratioSecondaryCanvas.toFixed(2)}`);
      assert.ok(ratioMutedCanvas >= 7.0, `HC muted text must be >= 7:1 (AAA), got ${ratioMutedCanvas.toFixed(2)}`);
      assert.ok(ratioPrimaryButton >= 7.0, `HC button text must be >= 7:1 (AAA), got ${ratioPrimaryButton.toFixed(2)}`);
    });

    it('verifies High Contrast focus ring and borders achieve ratio >= 3:1 against black', () => {
      const canvas = highContrastTokens['--color-bg-canvas'];
      const focusRing = highContrastTokens['--ring-focus-color'];
      const border = highContrastTokens['--color-border-strong'];

      const ratioFocus = calculateContrastRatio(focusRing, canvas);
      const ratioBorder = calculateContrastRatio(border, canvas);

      assert.ok(ratioFocus >= 3.0, `HC focus ring must be >= 3.0:1, got ${ratioFocus.toFixed(2)}`);
      assert.ok(ratioBorder >= 3.0, `HC border must be >= 3.0:1, got ${ratioBorder.toFixed(2)}`);
    });
  });

  describe('5. Z-Index Monotonicity & Layer Hierarchy (0..90)', () => {
    it('verifies strict non-overlapping z-index hierarchy', () => {
      const layers = [
        '--z-base',
        '--z-elevated',
        '--z-sticky',
        '--z-dropdown',
        '--z-drawer',
        '--z-backdrop',
        '--z-modal',
        '--z-popover',
        '--z-toast',
        '--z-critical-alert',
      ];

      let prevVal = -1;
      for (const layer of layers) {
        assert.ok(rootTokens[layer] !== undefined, `Missing z-index layer: ${layer}`);
        const currentVal = parseInt(rootTokens[layer], 10);
        assert.ok(!isNaN(currentVal), `Layer ${layer} must be an integer, got "${rootTokens[layer]}"`);
        assert.ok(currentVal > prevVal, `Layer ${layer} (${currentVal}) must be strictly greater than previous (${prevVal})`);
        prevVal = currentVal;
      }
      assert.equal(parseInt(rootTokens['--z-base'], 10), 0);
      assert.equal(parseInt(rootTokens['--z-critical-alert'], 10), 90);
    });
  });

  describe('6. Integration with Tailwind and index.css', () => {
    it('verifies @import "./styles/tokens.css"; is prepended in index.css', () => {
      const indexCss = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');
      const lines = indexCss.split('\n').map(l => l.trim()).filter(Boolean);
      assert.equal(lines[0], "@import './styles/tokens.css';", 'index.css line 1 must import tokens.css');
    });

    it('verifies tailwind.config.js extends theme with all semantic tokens', () => {
      const tailwindConfigContent = fs.readFileSync(TAILWIND_CONFIG_PATH, 'utf-8');
      assert.match(tailwindConfigContent, /darkMode:\s*['"]class['"]/, 'tailwind config must enable class dark mode');
      assert.match(tailwindConfigContent, /var\(--color-bg-canvas\)/, 'tailwind colors must reference --color-bg-canvas');
      assert.match(tailwindConfigContent, /var\(--color-bg-surface\)/, 'tailwind colors must reference --color-bg-surface');
      assert.match(tailwindConfigContent, /var\(--color-primary\)/, 'tailwind colors must reference --color-primary');
      assert.match(tailwindConfigContent, /var\(--z-critical-alert\)/, 'tailwind zIndex must reference --z-critical-alert');
      assert.match(tailwindConfigContent, /var\(--space-8\)/, 'tailwind spacing must reference --space-8');
    });
  });
});
