#!/usr/bin/env bash
# Package Speak for this runner's system and upload it to the draft release (release.yml). Signed
# when the repository has that system's secrets and variables (docs/signing.md), else unsigned,
# which macOS gets as an ad hoc signature. Sets SPEAK_SIGNED for scripts/check-release.mjs.
set -eo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

mac=(CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER)
win=(WIN_CSC_LINK WIN_CSC_KEY_PASSWORD AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_SIGNING_PROFILE WIN_PUBLISHER_NAME)
# Secrets that aren't set arrive empty, and electron-builder reads an empty CSC_LINK as a
# certificate path: unset them. And each system's stay on its own runner: on Windows,
# electron-builder signs with CSC_LINK too, which is the Mac certificate here.
for v in "${mac[@]}" "${win[@]}"; do [ -n "${!v}" ] || unset "$v"; done
[ "$RUNNER_OS" = macOS ] || unset "${mac[@]}"
[ "$RUNNER_OS" = Windows ] || unset "${win[@]}"

args=()
signed=0

if [ "$RUNNER_OS" = macOS ]; then
  # notarytool reads the App Store Connect API key from a file: the secret holds the .p8 file's text.
  if [ -n "$APPLE_API_KEY" ]; then
    printf '%s\n' "$APPLE_API_KEY" >"$RUNNER_TEMP/apple-api-key.p8"
    export APPLE_API_KEY="$RUNNER_TEMP/apple-api-key.p8"
  fi
  # electron-builder notarizes when one of these is set, and stops if the rest of its group isn't.
  notarize="$APPLE_ID$APPLE_APP_SPECIFIC_PASSWORD$APPLE_API_KEY$APPLE_API_KEY_ID$APPLE_API_ISSUER"
  if [ -n "$CSC_LINK" ]; then
    # Signed but not notarized, Speak would still be refused by macOS 15 and later.
    [ -n "$notarize" ] || fail "CSC_LINK is set, but not Apple's notarization: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER."
    signed=1
  else
    [ -z "$notarize" ] || fail "Apple's notarization is set, but not the Developer ID certificate (CSC_LINK, CSC_KEY_PASSWORD)."
    # Ad hoc: Apple Silicon Macs open it after the "unidentified developer" prompt, instead of
    # reporting it as damaged. With library validation off (see the entitlements file).
    args+=(-c.mac.identity=- -c.mac.entitlements=build/entitlements.adhoc.mac.plist -c.mac.entitlementsInherit=build/entitlements.adhoc.mac.plist)
  fi
fi

if [ "$RUNNER_OS" = Windows ]; then
  azure=(AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_SIGNING_PROFILE WIN_PUBLISHER_NAME)
  set_azure=$(for v in "${azure[@]}"; do [ -z "${!v}" ] || echo "$v"; done)
  if [ -n "$set_azure" ]; then
    for v in "${azure[@]}"; do
      [ -n "${!v}" ] || fail "Azure Artifact Signing needs $v too (docs/signing.md)."
    done
    # The publisher name must be the certificate's, exactly: installed versions refuse updates
    # signed by any other (scripts/check-release.mjs compares them).
    args+=(
      "-c.win.azureSignOptions.endpoint=$AZURE_SIGNING_ENDPOINT"
      "-c.win.azureSignOptions.codeSigningAccountName=$AZURE_SIGNING_ACCOUNT"
      "-c.win.azureSignOptions.certificateProfileName=$AZURE_SIGNING_PROFILE"
      "-c.win.azureSignOptions.publisherName=$WIN_PUBLISHER_NAME"
    )
    signed=1
  elif [ -n "$WIN_CSC_LINK" ]; then
    signed=1
  fi
fi

echo "SPEAK_SIGNED=$signed" >>"${GITHUB_ENV:-/dev/null}"
echo "Signed: $([ $signed = 1 ] && echo yes || echo no)"
npx electron-builder --publish always "${args[@]}"
