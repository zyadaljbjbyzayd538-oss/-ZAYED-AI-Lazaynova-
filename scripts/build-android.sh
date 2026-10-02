#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
OUTPUT_DIR="$ROOT_DIR/artifacts/android"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/mock/debug/app-mock-debug.apk"

if [[ -x "$ANDROID_DIR/gradlew" ]]; then
  GRADLE=("$ANDROID_DIR/gradlew" -p "$ANDROID_DIR")
elif command -v gradle >/dev/null 2>&1; then
  GRADLE=(gradle -p "$ANDROID_DIR")
else
  echo "Android build unavailable: install Gradle or provide an executable android/gradlew wrapper." >&2
  exit 127
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Android build unavailable: Java 17 is required." >&2
  exit 127
fi
JAVA_RELEASE="$(java -version 2>&1 | awk -F'"' '/version/ { print $2; exit }')"
JAVA_MAJOR="${JAVA_RELEASE%%.*}"
if [[ "$JAVA_MAJOR" == "1" ]]; then
  JAVA_MAJOR="${JAVA_RELEASE#1.}"
  JAVA_MAJOR="${JAVA_MAJOR%%.*}"
fi
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < 17 )); then
  echo "Android build unavailable: Java 17 or newer is required (detected '${JAVA_RELEASE:-unknown}')." >&2
  exit 127
fi

"${GRADLE[@]}" :app:ktlintCheck :app:detekt :app:testMockDebugUnitTest :app:assembleMockDebug
if [[ ! -s "$APK_PATH" ]]; then
  echo "Build did not produce the expected mock APK: $APK_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
install -m 0644 "$APK_PATH" "$OUTPUT_DIR/Lazaynova-mock-debug.apk"
printf 'Mock APK ready: %s\n' "$OUTPUT_DIR/Lazaynova-mock-debug.apk"
printf 'This APK uses local mock fixtures only; it does not contact a Lazaynova server.\n'
