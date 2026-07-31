/**
 * GPU resource keys advertised by the common device plugins. Used to detect
 * whether a node exposes GPUs (see lib/readinessChecks.js).
 */
export const GPU_RESOURCE_KEYS = [
  'nvidia.com/gpu',
  'amd.com/gpu',
  'gpu.intel.com/i915',
  'habana.ai/gaudi',
]
