import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'switchyard-theme';

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Reads the theme the inline script in `index.html` already applied (so
 * there is no flash on mount), and lets the caller flip it. Also follows the
 * system preference live for as long as the user has not made an explicit
 * choice in this browser.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      document.documentElement.classList.toggle('dark', media.matches);
      setTheme(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    apply(next);
    setTheme(next);
  };

  return [theme, toggle];
}
