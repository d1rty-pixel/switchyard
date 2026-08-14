import { useCallback, useEffect, useState } from 'react';

/** What the user picked. `system` follows the OS and is the default. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** What is actually on screen once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'switchyard-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Anything that is not an explicit `light`/`dark` — including a missing key,
 * a literal `system`, or a value from an older build — means "follow the OS".
 * The inline script in `index.html` reads the same value the same way.
 */
function storedPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

function paint(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Three-state theme preference, persisted per browser.
 *
 * The initial resolved value is read back off the document rather than
 * recomputed, because the inline script in `index.html` has already applied it
 * before first paint — recomputing here would be a second source of truth.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );

  // Only `system` tracks the OS; an explicit choice must survive the OS
  // flipping underneath it.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const next = media.matches ? 'dark' : 'light';
      paint(next);
      setResolved(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    // `system` is stored as the absence of a choice, so a browser that has
    // never been touched and one that was reset behave identically.
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);

    const theme = resolve(next);
    paint(theme);
    setPreferenceState(next);
    setResolved(theme);
  }, []);

  return { preference, resolved, setPreference };
}
