# StudyHop apps (iPhone, iPad, Android)

A Capacitor shell that opens the live StudyHop site. All building happens on GitHub Actions; nothing to install on the PC except git.

## One-time setup
1. Move the two files in `github-workflows/` to `.github/workflows/` (Claude's tools can't write `.github`), then `git add -A; git commit -m "StudyHop apps"; git push`.
2. GitHub > Settings > Secrets and variables > Actions:
   - iOS (Fortuna Technologies Apple account, same as DineHopper): `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (whole .p8 text).
   - Android: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (see "Android keystore" below).
3. App Store Connect > Apps > + New App: iOS, name StudyHop, language English (Australia), bundle ID com.studyhop.app (the first iOS run registers the App ID if it isn't there yet), SKU studyhop.
4. Google Play Console > Create app: StudyHop, app, free.

## Build
- Actions > **Release iOS** > Run workflow (target `test` until studyhop.com.au is on the worker, then `live`). Lands in TestFlight in ~10 minutes.
- Actions > **Build Android** > Run workflow. Download the artifact: `.apk` to install on a phone, `.aab` to upload to Play.

## Switch the address
`node scripts/set-target.mjs live` (studyhop.com.au) or `test` (workers.dev), or just pick it when running the workflow.

## Android keystore (once, on the PC; keep the file safe, it signs every future update)
```
cd C:\Users\Admin\Desktop\studyhop-apps; keytool -genkeypair -v -keystore studyhop-release.jks -alias studyhop -keyalg RSA -keysize 2048 -validity 10000
```
(keytool comes with Android Studio or any JDK.) Then `[Convert]::ToBase64String([IO.File]::ReadAllBytes("studyhop-release.jks")) | Set-Clipboard` and paste as `ANDROID_KEYSTORE_B64`. Never commit the .jks.

## Store listing needs
Privacy policy: https://studyhop.com.au/privacy · Terms: https://studyhop.com.au/terms · Category: Education · Age: kids (Apple Kids Category 5 & under / 6–8 / 9–11 or "Made for Kids" off; Google Play target audience includes children, Families policy).
