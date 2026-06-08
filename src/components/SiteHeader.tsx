"use client";

/**
 * SiteHeader — kept as a thin adapter so existing pages don't need a sweeping
 * import change. It now just renders ChromeBar. New code should import
 * ChromeBar directly and choose a `centre` / `rightSlot` per page.
 */

import { ChromeBar } from "@/components/ChromeBar";

export function SiteHeader() {
  return <ChromeBar />;
}
