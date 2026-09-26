// Erzeugt public/marketing/index.html aus marketing/index.template.html mit APP_NAME (#18).
// Läuft automatisch vor `npm run build` (prebuild); manuell: npm run build:marketing.
import { readFileSync, writeFileSync } from "node:fs";
import { APP_NAME } from "../src/lib/brand";
import { renderMarketing } from "../src/lib/marketing";

const template = readFileSync("marketing/index.template.html", "utf8");
writeFileSync("public/marketing/index.html", renderMarketing(template, APP_NAME));
console.log(`[marketing] public/marketing/index.html erzeugt (${APP_NAME})`);
