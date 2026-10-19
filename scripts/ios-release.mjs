// Builds and uploads the iOS app to TestFlight on a macOS GitHub runner, with nothing stored in the repo:
// 1. a distribution certificate and an App Store provisioning profile are created for this run through the
//    App Store Connect API (the key is the ASC_* secrets), put in a temporary keychain,
// 2. xcodebuild archives with manual signing and exports straight to App Store Connect,
// 3. the PREVIOUS run's certificate and profile are revoked at the start of each run (Apple validates the signature
//    minutes after upload, so this run's certificate must outlive the run; revoking it at once gives ITMS-90035).
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8. Run from the repo root.
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_KEY_P8: P8 } = process.env;
if (!KEY_ID || !ISSUER || !P8) { console.error("Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 secrets."); process.exit(1); }
const BUNDLE_ID = JSON.parse(readFileSync("capacitor.config.json", "utf8")).appId;
const RUN = process.env.GITHUB_RUN_NUMBER ?? String(Date.now());
const WORK = join(process.env.RUNNER_TEMP ?? tmpdir(), "ios-sign"); mkdirSync(WORK, { recursive: true });
const EXPORT = join(process.env.RUNNER_TEMP ?? tmpdir(), "export"); mkdirSync(EXPORT, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts }).trim();
const log = (m) => console.log(`\n== ${m}`);

// --- App Store Connect API ---
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" }), body = b64({ iss: ISSUER, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" });
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: createPrivateKey(P8), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}
async function api(method, path, body) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, { method, headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 600)}`);
  return j;
}

let certId = null, profileId = null, keychain = null;
const PROFILE_PREFIX = "StudyHop CI ";
/** Earlier runs' profiles (named "StudyHop CI <run>") and the certificates they used; this run's are left alone. */
async function revokeOldRuns() {
  log("Revoke previous runs' certificates");
  const list = await api("GET", "/v1/profiles?filter[profileType]=IOS_APP_STORE&include=certificates&limit=200");
  for (const prof of list.data) {
    if (!prof.attributes.name.startsWith(PROFILE_PREFIX) || prof.id === profileId) continue;
    for (const c of prof.relationships?.certificates?.data ?? []) if (c.id !== certId) await api("DELETE", `/v1/certificates/${c.id}`).then(() => console.log("revoked certificate", c.id)).catch((e) => console.log("revoke:", e.message));
    await api("DELETE", `/v1/profiles/${prof.id}`).then(() => console.log("deleted profile", prof.attributes.name)).catch((e) => console.log("delete:", e.message));
  }
}
async function cleanup(failed) {
  log("Cleanup");
  if (failed) {   // nothing was uploaded, so this run's certificate can go now
    if (profileId) await api("DELETE", `/v1/profiles/${profileId}`).catch(() => {});
    if (certId) await api("DELETE", `/v1/certificates/${certId}`).catch(() => {});
  } else console.log("certificate kept until the next run (Apple still has to validate this upload)");
  if (keychain) spawnSync("security", ["delete-keychain", keychain]);
}

let failed = false;
try {
  await revokeOldRuns();
  log("Bundle ID");
  let b = await api("GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&filter[platform]=IOS`);
  let bundle = b.data.find((x) => x.attributes.identifier === BUNDLE_ID);
  if (!bundle) { console.log("registering", BUNDLE_ID); bundle = (await api("POST", "/v1/bundleIds", { data: { type: "bundleIds", attributes: { identifier: BUNDLE_ID, name: "StudyHop", platform: "IOS" } } })).data; }
  console.log("bundle", bundle.id, bundle.attributes.seedId ?? "");

  log("Certificate (this run only)");
  const keyPem = join(WORK, "key.pem"), csrPem = join(WORK, "csr.pem");
  sh("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPem, "-out", csrPem, "-subj", "/CN=StudyHop CI/O=Fortuna Technologies/C=AU"]);
  const csr = readFileSync(csrPem, "utf8").replace(/-----[A-Z ]+-----|\n/g, "");
  const cert = (await api("POST", "/v1/certificates", { data: { type: "certificates", attributes: { certificateType: "IOS_DISTRIBUTION", csrContent: csr } } })).data;
  certId = cert.id;
  const certDer = join(WORK, "cert.der"), certPem = join(WORK, "cert.pem"), p12 = join(WORK, "cert.p12");
  writeFileSync(certDer, Buffer.from(cert.attributes.certificateContent, "base64"));
  sh("/usr/bin/openssl", ["x509", "-inform", "DER", "-in", certDer, "-out", certPem]);
  const subject = sh("/usr/bin/openssl", ["x509", "-in", certPem, "-noout", "-subject"]);
  const teamId = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject)?.[1];
  if (!teamId) throw new Error("Team ID not found in certificate subject: " + subject);
  console.log("certificate", certId, "team", teamId, "name:", cert.attributes.name);

  log("Profile (this run only)");
  const prof = (await api("POST", "/v1/profiles", { data: { type: "profiles", attributes: { name: `StudyHop CI ${RUN}`, profileType: "IOS_APP_STORE" },
    relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } }, certificates: { data: [{ type: "certificates", id: certId }] } } } })).data;
  profileId = prof.id;
  const profName = prof.attributes.name, profUuid = prof.attributes.uuid;
  const profBytes = Buffer.from(prof.attributes.profileContent, "base64");
  for (const dir of [join(homedir(), "Library/MobileDevice/Provisioning Profiles"), join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${profUuid}.mobileprovision`), profBytes); }
  console.log("profile", profName, profUuid);

  log("Keychain");
  const pass = randomBytes(16).toString("hex");
  keychain = join(WORK, "ci.keychain-db");
  sh("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", keyPem, "-in", certPem, "-out", p12, "-passout", `pass:${pass}`]);
  sh("security", ["create-keychain", "-p", pass, keychain]);
  sh("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  sh("security", ["unlock-keychain", "-p", pass, keychain]);
  // Apple's intermediate (WWDR G3) so the signature chain is complete inside the temporary keychain.
  const wwdr = join(WORK, "AppleWWDRCAG3.cer");
  writeFileSync(wwdr, Buffer.from(await (await fetch("https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer")).arrayBuffer()));
  sh("security", ["import", wwdr, "-k", keychain, "-T", "/usr/bin/codesign"]);
  sh("security", ["import", p12, "-k", keychain, "-P", pass, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security", "-T", "/usr/bin/productbuild"]);
  sh("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pass, keychain]);
  const existing = sh("security", ["list-keychains", "-d", "user"]).split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  sh("security", ["list-keychains", "-d", "user", "-s", keychain, ...existing]);
  console.log(sh("security", ["find-identity", "-v", "-p", "codesigning", keychain]));

  log("Archive");
  const archive = join(EXPORT, "App.xcarchive");
  const common = ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS",
    "CODE_SIGN_STYLE=Manual", `DEVELOPMENT_TEAM=${teamId}`, `PROVISIONING_PROFILE_SPECIFIER=${profName}`, "CODE_SIGN_IDENTITY=Apple Distribution", `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`];
  execFileSync("xcodebuild", [...common, "-archivePath", archive, "archive"], { stdio: "inherit" });

  log("Export and upload to App Store Connect");
  const keyDir = join(homedir(), ".private_keys"); mkdirSync(keyDir, { recursive: true });
  const keyPath = join(keyDir, `AuthKey_${KEY_ID}.p8`); writeFileSync(keyPath, P8);
  const opts = join(EXPORT, "exportOptions.plist");
  writeFileSync(opts, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>${teamId}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${profName}</string></dict>
</dict></plist>`);
  execFileSync("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportOptionsPlist", opts, "-exportPath", join(EXPORT, "out"),
    "-authenticationKeyPath", keyPath, "-authenticationKeyID", KEY_ID, "-authenticationKeyIssuerID", ISSUER, "-allowProvisioningUpdates"], { stdio: "inherit" });
  log(`Uploaded build ${RUN}. It appears in App Store Connect > TestFlight in a few minutes.`);
  rmSync(keyPath, { force: true });
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1; failed = true;
} finally {
  await cleanup(failed);
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
}
