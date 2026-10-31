const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".jar", ".war", ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

export function looksBinary(bytes: Uint8Array, path: string): boolean {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return true;
  return bytes.subarray(0, 8000).includes(0);
}
