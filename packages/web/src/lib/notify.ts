/**
 * Thin wrapper around the browser Notification API. Opt-in and best-effort:
 * a browser without support, or a user who never grants permission, just
 * gets no desktop notifications — the toast stream already covers the same
 * events while the tab is open.
 */

/**
 * Notifications that have been fired but not yet closed. The Notification
 * object is the only thing keeping the pending desktop banner alive: if it is
 * collected before the platform daemon renders it, the banner silently never
 * appears. Holding a reference until `close` fires is what makes delivery
 * reliable rather than dependent on GC timing.
 */
const live = new Set<Notification>();

export function notificationsSupported(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  // `Notification` is still exposed on insecure origins, but permission there
  // is permanently "denied" and cannot be granted. Reporting that as supported
  // sends the user off to fix Chrome's site settings, where there is nothing
  // to fix — the origin itself is the problem.
  return window.isSecureContext;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  return Notification.requestPermission();
}

/**
 * Fires a desktop notification. No-op if unsupported or not granted.
 *
 * `tag` groups notifications that supersede one another — pass a per-service
 * key so a burst of events (a compose stack stopping ten containers at once)
 * replaces one banner instead of firing ten that the desktop's notification
 * daemon then rate-limits and drops.
 */
export function notify(title: string, body?: string, tag?: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    // `renotify` re-alerts on a replaced tag; without it a tagged notification
    // swaps in silently, which for an action result reads as nothing happening.
    // It is missing from lib.dom's NotificationOptions, which types only the
    // subset the spec guarantees outside a service worker. Chrome honours it,
    // and it is inert elsewhere. Setting it without a tag throws, hence the
    // Boolean(tag) rather than a bare true.
    const options: NotificationOptions & { renotify?: boolean } = {
      body,
      tag,
      renotify: Boolean(tag),
    };
    const notification = new Notification(title, options);
    live.add(notification);
    notification.onclose = () => live.delete(notification);
    notification.onerror = () => live.delete(notification);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some platforms throw for notifications outside a service worker; not
    // worth surfacing to the user over a best-effort feature.
  }
}
