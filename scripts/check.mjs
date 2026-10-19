// Preflight before a build: config, platforms, icons.
import { existsSync, readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../capacitor.config.json", import.meta.url), "utf8"));
const problems = [];
if (!/^https:\/\//.test(cfg.server?.url ?? "")) problems.push("server.url must be https");
if (cfg.appId !== "au.com.studyhop.app") problems.push("appId changed");
for (const p of ["android/app/build.gradle", "ios/App/App.xcodeproj/project.pbxproj", "ios/App/App/Info.plist", "assets/icon.png", "assets/splash.png"]) if (!existsSync(new URL("../" + p, import.meta.url))) problems.push("missing " + p);
const plist = readFileSync(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8");
if (!plist.includes("ITSAppUsesNonExemptEncryption")) problems.push("Info.plist: ITSAppUsesNonExemptEncryption missing");
if (problems.length) { console.error("Preflight failed:\n - " + problems.join("\n - ")); process.exit(1); }
console.log(`Preflight OK: ${cfg.appName} (${cfg.appId}) opens ${cfg.server.url}`);
