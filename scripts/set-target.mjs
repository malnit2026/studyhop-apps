// Point the app at an address: node scripts/set-target.mjs live | test
// live = https://studyhop.com.au (once the domain is on the worker), test = the workers.dev address.
import { readFileSync, writeFileSync } from "node:fs";
const which = process.argv[2] ?? "live";
const urls = { live: "https://studyhop.com.au", test: "https://syllabus-coach.trestlehq.workers.dev" };
if (!urls[which]) { console.error("Use: live | test"); process.exit(1); }
const f = new URL("../capacitor.config.json", import.meta.url);
const cfg = JSON.parse(readFileSync(f, "utf8"));
cfg.server.url = urls[which];
writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
console.log(`App opens ${cfg.server.url}. Now run: npx cap sync`);
