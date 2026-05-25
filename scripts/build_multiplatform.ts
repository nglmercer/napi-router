import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";
import os from "os";

// ── macOS SDK setup ─────────────────────────────────────────────────────────
const SDK_VERSION = "13.3";
const SDK_NAME = `MacOSX${SDK_VERSION}.sdk`;
const SDK_URL = `https://github.com/roblabla/MacOSX-SDKs/releases/download/${SDK_VERSION}/${SDK_NAME}.tar.xz`;
const SDK_CACHE_DIR = join(os.homedir(), ".cache", "macos-sdk");
const SDK_PATH = join(SDK_CACHE_DIR, SDK_NAME);

async function ensureMacOSSdk(): Promise<string> {
  if (existsSync(SDK_PATH)) {
    console.log(`  \u2713 macOS SDK found at ${SDK_PATH}`);
    return SDK_PATH;
  }

  console.log(`  \u2B07  Downloading macOS ${SDK_VERSION} SDK (~60 MB)...`);
  await $`mkdir -p ${SDK_CACHE_DIR}`;
  await $`curl -fsSL ${SDK_URL} | tar -xJ -C ${SDK_CACHE_DIR}`;
  console.log(`  \u2713 macOS SDK extracted to ${SDK_PATH}`);
  return SDK_PATH;
}

// ── Build targets ───────────────────────────────────────────────────────────
// Matches the "napi.targets" list in package.json.
// aarch64-pc-windows-msvc is included as an extra cross-compile target even
// though it is not (yet) in the default release matrix.
const targets = [
  { target: "x86_64-pc-windows-msvc",   cross: true,        apple: false },
  { target: "aarch64-pc-windows-msvc",  xwinDirect: true,   apple: false },
  { target: "i686-pc-windows-msvc",     cross: true,        apple: false },
  { target: "x86_64-apple-darwin",      cross: true,        apple: true  },
  { target: "aarch64-apple-darwin",     cross: true,        apple: true  },
  { target: "aarch64-unknown-linux-gnu", napiCross: true,   apple: false },
  { target: "x86_64-unknown-linux-gnu",  native: true,      apple: false },
] as const;

// ── Main ────────────────────────────────────────────────────────────────────
console.log("Building multiplatform binaries for napi-router...\n");

// 1. Install Rust targets
console.log("Ensuring Rust targets are installed...");
for (const { target } of targets) {
  try {
    await $`rustup target add ${target}`.quiet();
  } catch {
    // already installed or unavailable
  }
}

// 2. Pre-download macOS SDK (shared across both Darwin targets)
let sdkRoot: string | undefined;
const needsApple = targets.some((t) => t.apple);
if (needsApple && process.platform !== "darwin") {
  console.log("\nPreparing macOS SDK for cross-compilation...");
  try {
    sdkRoot = await ensureMacOSSdk();
  } catch (e) {
    console.error("  Failed to obtain macOS SDK:", (e as Error).message);
    sdkRoot = process.env.SDKROOT;
  }
} else if (needsApple) {
  // Native macOS build — SDK is already available via Xcode
  sdkRoot = process.env.SDKROOT;
}

// 3. Sequential builds
const results: { target: string; success: boolean }[] = [];

for (const cfg of targets) {
  const { target } = cfg;
  console.log(`\nBuilding for ${target}...`);

  try {
    if ("native" in cfg && cfg.native) {
      await $`npx napi build --release --platform`;

    } else if ("napiCross" in cfg && cfg.napiCross) {
      // Linux cross via napi-cross (docker / qemu)
      await $`npx napi build --release --target ${target} --use-napi-cross --platform`;

    } else if ("xwinDirect" in cfg && cfg.xwinDirect) {
      // aarch64-pc-windows-msvc: napi-cross doesn't support this triple from x64.
      // Use cargo-xwin with XWIN_ARCH=aarch64 to download the ARM64 Windows SDK.
      const env = {
        ...process.env,
        XWIN_ARCH: "aarch64",
        CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER: "lld-link",
      };
      await $`npx napi build --release --target ${target} --cross-compile --platform`.env(env);

    } else if ("cross" in cfg && cfg.cross) {
      if (cfg.apple && sdkRoot) {
        process.env.SDKROOT = sdkRoot;
        await $`npx napi build --release --target ${target} --cross-compile --platform`;
        delete process.env.SDKROOT;
      } else if (cfg.apple) {
        console.warn(`  Skipping ${target}: no macOS SDK available (set SDKROOT to fix)`);
        results.push({ target, success: false });
        continue;
      } else {
        // Windows cross via cargo-xwin
        await $`npx napi build --release --target ${target} --cross-compile --platform`;
      }
    }

    console.log(`  \u2713 ${target}`);
    results.push({ target, success: true });
  } catch (error) {
    console.error(`  \u2717 ${target}`);
    results.push({ target, success: false });
  }
}

// 4. Summary
console.log("\nBuild Summary:");
results.forEach((r) => {
  console.log(`${r.success ? "\u2713" : "\u2717"} ${r.target}`);
});

if (results.some((r) => !r.success)) {
  console.log("\nSome builds failed. Check the logs above.");
  process.exit(1);
} else {
  console.log("\nAll multiplatform builds complete!");
}
