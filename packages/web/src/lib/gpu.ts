/**
 * Best-effort detection of whether the browser is compositing with real GPU
 * hardware acceleration, vs. a software fallback renderer (SwiftShader,
 * llvmpipe, ...). There is no direct "is HW accel on" API; the standard
 * heuristic is reading the WebGL unmasked renderer string, which self-reports
 * software rasterizers by name.
 *
 * Used to skip expensive-to-repaint-in-software effects (backdrop blur, large
 * shadow blur radii) on animated elements when there's no GPU to composite
 * them for free.
 */

const SOFTWARE_RENDERER_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /software rasterizer/i,
  /software renderer/i,
  /mesa.*(software|off-?screen)/i,
];

function detect(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);

    if (!renderer) return true; // unknown renderer string: assume HW accel rather than degrade
    return !SOFTWARE_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer));
  } catch {
    return true; // detection failed: don't punish the common case for a rare one
  }
}

// GPU state doesn't change mid-session; compute once and reuse everywhere.
let cached: boolean | null = null;

export function hasGpuAcceleration(): boolean {
  if (cached === null) cached = detect();
  return cached;
}
