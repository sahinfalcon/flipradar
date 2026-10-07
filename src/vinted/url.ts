export function catalogUrl(host: string, termKey: string, page = 1): string {
  const params = new URLSearchParams({ search_text: termKey, order: "newest_first" });
  if (page > 1) params.set("page", String(page));
  return `https://${host}/catalog?${params.toString()}`;
}
