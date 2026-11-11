# Code signing

Release builds are signed once the repository has each system's secrets (**Settings → Secrets and variables → Actions**). Until then, `.github/workflows/release.yml` builds them unsigned. macOS gets an ad hoc signature, so Apple Silicon Macs can open it after a warning. Each system is independent: set up macOS alone, Windows alone, or both. Linux needs nothing.

| System  | Without signing                                                                              | Signed                                                                                         |
| ------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| macOS   | "Unidentified developer"; on macOS 15+, **Open Anyway** in System Settings. No auto-updates. | Opens with no warning. Updates itself, and keeps its permissions from one version to the next. |
| Windows | "Windows protected your PC", unknown publisher.                                              | Your name as publisher. SmartScreen may still warn until the certificate earns reputation.     |
| Linux   | No warning.                                                                                  | Not needed.                                                                                    |

`scripts/package-release.sh` passes each system's secrets to its own build only, and stops on an incomplete setup (for example, a certificate without notarization). After packaging, the **Check the packages** step (`scripts/check-release.mjs`) checks every build:

- Electron's fuses (see `electronFuses` in `electron-builder.yml`).
- The signature of signed builds:
  - macOS: Gatekeeper accepts the app as notarized, and its ticket is stapled.
  - Windows: each signed file is valid, and its signer is the publisher name that updates are checked against.
- Speak starts with `--self-check`, which loads the native modules and starts control mode's accessibility bridge.

The draft release is uploaded before the check runs. If the check fails, don't publish the draft.

## macOS: Developer ID and notarization

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) (99 USD a year), as an individual or as an organization. An organization needs a D-U-N-S number.
2. Create a **Developer ID Application** certificate. In Xcode, go to Settings → Accounts → Manage Certificates. Alternatively, use [Certificates](https://developer.apple.com/account/resources/certificates/list) on the developer site, with a request made in Keychain Access. Then, in Keychain Access, export the certificate with its private key as a `.p12` file protected by a password.
3. Pick a way to notarize:
   - **Apple ID**: create an app-specific password at [account.apple.com](https://account.apple.com) (Sign-In and Security). Your Team ID is under Membership details on the developer site.
   - **App Store Connect API key**: in App Store Connect, go to Users and Access → Integrations → Team Keys. Create a key with Developer access, download its `.p8` file (you can download it only once), and note its Key ID and the Issuer ID.
4. Add these secrets:

| Secret                                                     | Value                                                                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`                                                 | The `.p12` file in base64. On a Mac: `base64 -i cert.p12 \| pbcopy`. On Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.p12')) \| Set-Clipboard`. |
| `CSC_KEY_PASSWORD`                                         | The `.p12` file's password                                                                                                                                                       |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | For notarizing with an Apple ID                                                                                                                                                  |
| or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | For notarizing with an API key. `APPLE_API_KEY` is the text of the `.p8` file.                                                                                                   |

Signed builds use the hardened runtime with `build/entitlements.mac.plist`: JavaScript's compiler, the microphone, and Apple Events (for opening Terminal to sign in to an AI provider). Library validation stays on. Ad hoc builds use `build/entitlements.adhoc.mac.plist`, which turns library validation off, because their signature has no team ID.

**The first signed version.** Macs running an ad hoc version (0.5.x or earlier) can't update to it by themselves: Speak's updater installs an update only if it's signed like the app it replaces. Those users download it once from the releases page, then allow its permissions once more, because macOS ties permissions to the signature. After that, updates install by themselves and the permissions stay.

## Windows

Since 2023, code-signing keys must live in hardware or a cloud service, and certificates last at most 460 days (since 2026). No certificate skips SmartScreen anymore, EV included: the warning fades as the certificate builds reputation through downloads.

### Azure Artifact Signing (recommended)

Microsoft's cloud signing service costs about 10 USD a month on the [Basic plan](https://azure.microsoft.com/pricing/details/artifact-signing/), and electron-builder supports it. Identity validation is open to organizations. For individuals, it depends on the country (it wasn't available in France in March 2026): check the [quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart).

1. In an Azure subscription, create an **Artifact Signing account**. Its Overview page shows its endpoint (its URI).
2. Request an **identity validation** (Public Trust) and wait for its approval. Requesting one takes the Artifact Signing Identity Verifier role.
3. Create a **certificate profile** (Public Trust) from the validated identity.
4. In Microsoft Entra ID, register an app for the workflow and create a client secret for it. On the certificate profile (or on the account), give the app the **Artifact Signing Certificate Profile Signer** role.
5. Add these secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` (the app's), and `AZURE_CLIENT_SECRET`.
6. Add these variables (the **Variables** tab):

| Variable                 | Value                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `AZURE_SIGNING_ENDPOINT` | The account's endpoint, as on its Overview page                                         |
| `AZURE_SIGNING_ACCOUNT`  | The account's name                                                                      |
| `AZURE_SIGNING_PROFILE`  | The certificate profile's name                                                          |
| `WIN_PUBLISHER_NAME`     | The name the certificate is issued to (its subject CN), exactly: the validated identity |

### A certificate file

A certificate exported as a `.pfx` file, from a certificate authority, works too: set `WIN_CSC_LINK` (the file in base64) and `WIN_CSC_KEY_PASSWORD`. Most certificates issued today can't be exported, though. Their key stays on a token or in the authority's cloud, and signing then goes through the authority's own tool, which this workflow doesn't call.

### The publisher name

electron-builder signs `Speak.exe`, the installer, and Speak's `.dll` and `.node` files (`signExts` in `electron-builder.yml`). It writes the publisher name into the app (`app-update.yml`). A signed Speak then installs only updates signed under that name. Unsigned versions check nothing, so they update to the first signed version by themselves.

Keep the name. If the certificate's name ever changes, first release a version that accepts both names (`publisherName` can list several), and only then sign with the new one.
