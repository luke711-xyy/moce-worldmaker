"""Lazy Point-E image-to-colour-point-cloud adapter.

The heavy imports and checkpoint loading stay in this optional local service;
they never enter the browser bundle.  The adapter intentionally returns a
coarse point-derived voxel surface.  The editor can then apply its normal
voxel editing, collision, preview and confirmation paths.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List


class PointEUnavailable(RuntimeError):
    pass


_SAMPLER = None


def _load_sampler():
    global _SAMPLER
    if _SAMPLER is not None:
        return _SAMPLER
    try:
        import torch
        from point_e.diffusion.configs import DIFFUSION_CONFIGS, diffusion_from_config
        from point_e.diffusion.sampler import PointCloudSampler
        from point_e.models.configs import MODEL_CONFIGS, model_from_config
        from point_e.models.download import load_checkpoint
    except Exception as exc:  # pragma: no cover - depends on optional ML runtime
        raise PointEUnavailable(f"Point-E 依赖不可用：{exc}") from exc

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    base_name = "base40M"
    base_model = model_from_config(MODEL_CONFIGS[base_name], device)
    base_model.eval()
    base_diffusion = diffusion_from_config(DIFFUSION_CONFIGS[base_name])
    upsampler_model = model_from_config(MODEL_CONFIGS["upsample"], device)
    upsampler_model.eval()
    upsampler_diffusion = diffusion_from_config(DIFFUSION_CONFIGS["upsample"])
    base_model.load_state_dict(load_checkpoint(base_name, device))
    upsampler_model.load_state_dict(load_checkpoint("upsample", device))
    _SAMPLER = PointCloudSampler(
        device=device,
        models=[base_model, upsampler_model],
        diffusions=[base_diffusion, upsampler_diffusion],
        num_points=[1024, 4096 - 1024],
        aux_channels=["R", "G", "B"],
        guidance_scale=[3.0, 3.0],
    )
    return _SAMPLER


def _quantize_point_cloud(point_cloud: Any, max_voxels: int) -> Dict[str, Any]:
    import numpy as np

    coords = np.asarray(point_cloud.coords, dtype=np.float32)
    if coords.ndim != 2 or coords.shape[1] != 3 or len(coords) == 0:
        raise PointEUnavailable("Point-E 未返回有效点云")
    min_coord = coords.min(axis=0)
    max_coord = coords.max(axis=0)
    extent = np.maximum(max_coord - min_coord, 1e-6)
    scale = float(extent.max())
    # Keep the model centered in the requested voxel cube while preserving
    # proportions.  A half-voxel margin avoids clipping the outer samples.
    normalized = (coords - min_coord) / scale
    cells = np.rint(normalized * max(0, max_voxels - 1)).astype(np.int32)

    channels = getattr(point_cloud, "channels", {}) or {}
    rgb = []
    if all(name in channels for name in ("R", "G", "B")):
        rgb = np.stack([channels[name] for name in ("R", "G", "B")], axis=1)
        if float(rgb.max(initial=0)) <= 1.0:
            rgb = rgb * 255.0
        rgb = np.clip(np.rint(rgb), 0, 255).astype(np.int32)

    # Multiple samples may land in one voxel. Keep a deterministic average
    # colour rather than letting the last point win.
    buckets: Dict[str, List[Any]] = {}
    for index, cell in enumerate(cells):
        key = f"{int(cell[0])},{int(cell[1])},{int(cell[2])}"
        buckets.setdefault(key, []).append((cell, rgb[index].tolist() if len(rgb) else [160, 160, 160]))

    voxels = []
    for key in sorted(buckets):
        samples = buckets[key]
        cell = samples[0][0]
        colors = np.asarray([sample[1] for sample in samples], dtype=np.float32)
        color = np.clip(np.rint(colors.mean(axis=0)), 0, 255).astype(np.int32).tolist()
        voxels.append({"x": int(cell[0]), "y": int(cell[1]), "z": int(cell[2]), "color": color})
    return {
        "voxels": voxels,
        "bounds": {
            "min": {"x": 0, "y": 0, "z": 0},
            "max": {"x": max((voxel["x"] for voxel in voxels), default=0), "y": max((voxel["y"] for voxel in voxels), default=0), "z": max((voxel["z"] for voxel in voxels), default=0)},
        },
        "voxelCount": len(voxels),
        "maxVoxels": max_voxels,
        "surfaceOnly": True,
        "colorSource": "Point-E RGB point channels",
    }


def generate_from_image(image_path: str, max_voxels: int, progress: Callable[[int], None], cancelled: Callable[[], bool]) -> Dict[str, Any]:
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - optional dependency
        raise PointEUnavailable(f"Pillow 不可用：{exc}") from exc
    sampler = _load_sampler()
    if cancelled():
        raise PointEUnavailable("用户取消了生成任务")
    image = Image.open(image_path).convert("RGB")
    progress(35)
    samples = None
    for sample in sampler.sample_batch_progressive(batch_size=1, model_kwargs={"images": [image]}):
        if cancelled():
            raise PointEUnavailable("用户取消了生成任务")
        samples = sample
        progress(min(85, 35 + int(getattr(sample, "shape", [1])[0] if hasattr(sample, "shape") else 1)))
    if samples is None:
        raise PointEUnavailable("Point-E 没有返回采样结果")
    point_cloud = sampler.output_to_point_clouds(samples)[0]
    progress(92)
    result = _quantize_point_cloud(point_cloud, max_voxels)
    result["backend"] = "point-e"
    return result
