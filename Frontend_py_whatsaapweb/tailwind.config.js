// Frontend_py_whatsaapweb/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--color-bg-canvas)',
        surface: {
          DEFAULT: 'var(--color-bg-surface)',
          elevated: 'var(--color-bg-surface-elevated)',
        },
        primary: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          contrast: 'var(--color-primary-contrast)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
        },
        channel: {
          whatsapp: 'var(--color-channel-whatsapp)',
          telegram: 'var(--color-channel-telegram)',
          instagram: 'var(--color-channel-instagram)',
        },
      },
      backgroundColor: {
        canvas: 'var(--color-bg-canvas)',
        surface: 'var(--color-bg-surface)',
        'surface-elevated': 'var(--color-bg-surface-elevated)',
      },
      borderColor: {
        subtle: 'var(--color-border-subtle)',
        strong: 'var(--color-border-strong)',
        interactive: 'var(--color-border-interactive)',
      },
      textColor: {
        primary: 'var(--color-text-primary)',
        secondary: 'var(--color-text-secondary)',
        muted: 'var(--color-text-muted)',
        'primary-brand': 'var(--color-primary)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        'display-lg': ['1.5rem', { lineHeight: '2rem', fontWeight: '700' }],
        'heading-md': ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        'heading-sm': ['0.9375rem', { lineHeight: '1.25rem', fontWeight: '600' }],
        'body-md': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '400' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.125rem', fontWeight: '400' }],
        'caption': ['0.6875rem', { lineHeight: '0.875rem', fontWeight: '500' }],
        'code-sm': ['0.75rem', { lineHeight: '1rem', fontWeight: '400' }],
      },
      spacing: {
        '1': 'var(--space-1)',
        '2': 'var(--space-2)',
        '3': 'var(--space-3)',
        '4': 'var(--space-4)',
        '6': 'var(--space-6)',
        '8': 'var(--space-8)',
      },
      borderRadius: {
        'sm': 'var(--radius-sm)',
        'md': 'var(--radius-md)',
        'lg': 'var(--radius-lg)',
        'xl': 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      zIndex: {
        'base': 'var(--z-base)',
        'elevated': 'var(--z-elevated)',
        'sticky': 'var(--z-sticky)',
        'dropdown': 'var(--z-dropdown)',
        'drawer': 'var(--z-drawer)',
        'backdrop': 'var(--z-backdrop)',
        'modal': 'var(--z-modal)',
        'popover': 'var(--z-popover)',
        'toast': 'var(--z-toast)',
        'critical-alert': 'var(--z-critical-alert)',
      },
      boxShadow: {
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
        'elevated': 'var(--shadow-elevated)',
      },
    },
  },
  plugins: [],
}