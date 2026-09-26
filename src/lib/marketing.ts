/**
 * Setzt Produktname und Slug in die Marketing-Vorlage ein (#18). Der Slug speist die
 * Deko-Adressleisten der Screenshots (app.<slug>.app). Unbekannte Platzhalter sind ein Fehler.
 */
export function renderMarketing(template: string, brand: { name: string; slug: string }): string {
  const html = template.replaceAll("{{APP_NAME}}", brand.name).replaceAll("{{APP_SLUG}}", brand.slug);
  const left = html.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`Unbekannter Platzhalter in der Marketing-Vorlage: ${left[0]}`);
  return html;
}
