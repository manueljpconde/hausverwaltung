/** Setzt den Produktnamen in die Marketing-Vorlage ein (#18). Unbekannte Platzhalter sind ein Fehler. */
export function renderMarketing(template: string, appName: string): string {
  const html = template.replaceAll("{{APP_NAME}}", appName);
  const left = html.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`Unbekannter Platzhalter in der Marketing-Vorlage: ${left[0]}`);
  return html;
}
