import { themeOptions, useTheme } from '../../../shared/theme/useTheme';

export default function ThemeSection() {
  const { theme, setTheme } = useTheme();

  return (
    <label className="flex items-center justify-between gap-4 border-b border-subtle py-3 md:py-4">
      <span className="text-base text-primary md:text-lg">Tema</span>
      <select
        className="min-h-11 rounded-md border border-interactive bg-surface px-3 text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        value={theme}
        onChange={(event) => {
          const selected = themeOptions.find((option) => option === event.currentTarget.value);
          if (selected) setTheme(selected);
        }}
      >
        {themeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}
