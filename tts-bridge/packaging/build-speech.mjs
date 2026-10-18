import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  cpSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = join(root, ".packaging");
const pins = JSON.parse(
  readFileSync(new URL("speech-lock.json", import.meta.url)),
);
mkdirSync(scratch, { recursive: true });
const source = join(scratch, "pinned-speech");
// Git Bash also puts GNU tar on PATH; it treats D:\... as a remote archive.
// Use Windows' native bsdtar for Windows paths.
const tar =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe")
    : "tar";
for (const [name, pin] of Object.entries(pins)) {
  const archive = join(scratch, `${name}-${pin.commit}.tar.gz`);
  if (!existsSync(archive)) {
    const response = await fetch(
      `https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`,
    );
    if (!response.ok) throw Error(`Source download failed: ${name}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (
    createHash("sha256").update(readFileSync(archive)).digest("hex") !==
    pin.sha256
  )
    throw Error(`Source checksum mismatch: ${name}`);
}
// Re-extract verified inputs every time: an edited local source tree is never
// silently accepted as the pinned release source.
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
for (const [name, pin] of Object.entries(pins)) {
  const dest = name === "speech" ? source : join(source, "ggml");
  mkdirSync(dest, { recursive: true });
  execFileSync(tar, [
    "-xzf",
    join(scratch, `${name}-${pin.commit}.tar.gz`),
    "-C",
    dest,
    "--strip-components=1",
  ]);
}
const windows = process.platform === "win32";
if (!(
  (windows && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64")
))
  throw Error("Unsupported target");
const config = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  "-DGGML_VULKAN=OFF",
  "-DGIT_EXE=",
  `-DGGML_BUILD_COMMIT=${pins.ggml.commit}`,
];
if (windows) {
  // clang-cl supports prefix mapping for __FILE__ and debug records. Keep the
  // Windows ABI/static CRT while removing absolute paths from ggml assertions.
  const roots = [
    ...new Set([root.replaceAll("\\", "/"), root.replaceAll("/", "\\")]),
  ];
  const map = roots
    .map((path) => `/clang:-ffile-prefix-map="${path}=source/"`)
    .join(" ");
  config.push(
    "-T",
    "ClangCL",
    "-A",
    "x64",
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    "-DGGML_METAL=OFF",
    "-DGGML_AVX=OFF",
    "-DGGML_AVX2=OFF",
    "-DGGML_FMA=OFF",
    "-DGGML_F16C=OFF",
    // Setting CMAKE_<LANG>_FLAGS replaces CMake's MSVC defaults; restate them
    // (/EHsc enables C++ exceptions, which clang-cl otherwise rejects).
    `-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS ${map}`,
    `-DCMAKE_CXX_FLAGS=/DWIN32 /D_WINDOWS /EHsc ${map}`,
    "-DCMAKE_EXE_LINKER_FLAGS=/PDBALTPATH:speech.pdb",
  );
} else {
  const map = `-ffile-prefix-map=${root}=source -ffile-prefix-map=${scratch}=build`;
  config.push(
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    `-DCMAKE_C_FLAGS=${map}`,
    `-DCMAKE_CXX_FLAGS=${map}`,
  );
}
// Keep independent caches per source revision without exceeding MSBuild's
// legacy 260-character limit in its nested compiler-probe tracking files.
const buildKey = createHash("sha256")
  .update(
    `${pins.speech.commit}:${pins.ggml.commit}:${windows ? "clangcl-pathmap-v2" : "apple-clang"}`,
  )
  .digest("hex")
  .slice(0, 12);
const build = join(scratch, `s-${buildKey}`);
execFileSync("cmake", ["-S", source, "-B", build, ...config], {
  stdio: "inherit",
});
execFileSync(
  "cmake",
  [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "speech-cli",
    "--parallel",
    "4",
  ],
  { stdio: "inherit" },
);
const nativeBuild = join(scratch, "native-build");
execFileSync(
  "cmake",
  [
    "-S",
    join(root, "packaging/native"),
    "-B",
    nativeBuild,
    "-DCMAKE_BUILD_TYPE=Release",
    ...(windows ? ["-A", "x64"] : []),
  ],
  { stdio: "inherit" },
);
execFileSync("cmake", ["--build", nativeBuild, "--config", "Release"], {
  stdio: "inherit",
});
const output = join(scratch, "speech-runtime");
rmSync(output, { recursive: true, force: true });
mkdirSync(output);
for (const [dir, name] of [
  [build, "speech"],
  [nativeBuild, "bridge-supervisor"],
]) {
  const filename = `${name}${windows ? ".exe" : ""}`;
  cpSync(
    join(dir, ...(windows ? ["Release"] : []), filename),
    join(output, filename),
  );
}
for (const [name, src] of [
  ["speech.cpp-LICENSE", join(source, "LICENSE")],
  ["ggml-LICENSE", join(source, "ggml/LICENSE")],
])
  cpSync(src, join(output, name));
// HTTP and JSON libraries have their own notices in the source distribution.
function notices(dir, rel = "") {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name),
      relative = join(rel, e.name);
    if (e.isDirectory()) notices(path, relative);
    else if (/^(license|copying|notice)/i.test(e.name)) {
      const dest = join(output, "licenses", relative);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
    }
  }
}
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
notices(join(source, "vendor"));
writeFileSync(
  join(output, "build.json"),
  JSON.stringify(
    {
      ...pins,
      target: `${process.platform}-${process.arch}`,
      backend: windows ? "cpu" : "metal",
    },
    null,
    2,
  ),
);
console.log("Pinned speech.cpp and supervisor built");
