/**
 * Thin wrapper around the browser Notification API. Opt-in and best-effort:
 * a browser without support, or a user who never grants permission, just
 * gets no desktop notifications — the toast stream already covers the same
 * events while the tab is open.
 */

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  return Notification.requestPermission();
}

/** Fires a desktop notification. No-op if unsupported, denied, or the tab is focused. */
export function notify(title: string, body?: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  // The tab already shows a toast for anything happening while it has focus;
  // a desktop notification on top of that would just double up the alert.
  if (document.hasFocus()) return;
  try {
    new Notification(title, { body });
  } catch {
    // Some platforms throw for notifications outside a service worker; not
    // worth surfacing to the user over a best-effort feature.
  }
}
