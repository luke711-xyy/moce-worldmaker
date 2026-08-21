#!/usr/bin/env python3
"""Local image-to-point-cloud service used by the MCP bridge.

Point-E is optional and loaded lazily.  The HTTP contract stays available
without its heavyweight dependencies, but generation fails explicitly rather
than returning a fake successful model.
"""
import json
import os
import pathlib
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from point_e_adapter import PointEUnavailable, generate_from_image
except ImportError:
    PointEUnavailable = RuntimeError
    generate_from_image = None

HOST, PORT = "127.0.0.1", int(os.environ.get("MOCE_LOCAL_3D_PORT", "32124"))
JOBS = {}
LOCK = threading.Lock()

try:
    import point_e  # type: ignore  # noqa: F401
    BACKEND = "point-e"
except ImportError:
    BACKEND = "unavailable"

def new_job(image_path, max_voxels):
    job_id = uuid.uuid4().hex
    with LOCK:
        JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "imagePath": image_path, "maxVoxels": max_voxels, "cancelRequested": False}
    return JOBS[job_id]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): return
    def send_json(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def do_GET(self):
        if self.path == "/health": return self.send_json(200, {"ok": True, "service": "moce-local-3d", "backend": BACKEND, "pointEAvailable": BACKEND == "point-e"})
        if self.path.startswith("/jobs/"):
            job = JOBS.get(self.path.split("/", 2)[-1]); return self.send_json(200 if job else 404, job or {"error": "job_not_found"})
        self.send_json(404, {"error": "not_found"})
    def do_POST(self):
        if self.path.startswith("/jobs/"):
            job_id = self.path.split("/", 2)[-1]
            with LOCK: job = JOBS.get(job_id)
            if not job: return self.send_json(404, {"error": "job_not_found"})
            if self.path.endswith("/cancel"):
                with LOCK: job.update(cancelRequested=True, status="cancelled", progress=job.get("progress", 0), error="用户取消了生成任务")
                return self.send_json(200, job)
            if self.path.endswith("/confirm"):
                if job.get("status") != "completed": return self.send_json(409, {"error": "job_not_ready"})
                with LOCK: job.update(confirmed=True)
                return self.send_json(200, job)
            return self.send_json(404, {"error": "not_found"})
        if self.path != "/jobs": return self.send_json(404, {"error": "not_found"})
        try: body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError: return self.send_json(400, {"error": "invalid_json"})
        image_path = body.get("imagePath")
        if not isinstance(image_path, str) or not image_path.strip(): return self.send_json(400, {"error": "imagePath_required", "message": "必须提供本机图片路径"})
        image_file = pathlib.Path(image_path).expanduser()
        if not image_file.is_file(): return self.send_json(400, {"error": "image_not_found", "message": "本机图片不存在或不可读"})
        if image_file.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}: return self.send_json(400, {"error": "image_format_unsupported", "message": "仅支持 PNG/JPEG/WebP 图片"})
        max_voxels = int(body.get("maxVoxels", 32)); max_voxels = max(1, min(256, max_voxels))
        job = new_job(str(image_file), max_voxels)
        threading.Thread(target=run_job, args=(job["id"],), daemon=True).start()
        self.send_json(202, job)

def run_job(job_id):
    with LOCK: JOBS[job_id].update(status="running", progress=5)
    job = JOBS[job_id]
    def progress(value):
        with LOCK:
            if job.get("status") != "cancelled": job.update(progress=max(0, min(99, int(value))))
    def cancelled():
        with LOCK: return bool(job.get("cancelRequested")) or job.get("status") == "cancelled"
    if BACKEND != "point-e" or generate_from_image is None:
        with LOCK: job.update(status="failed", progress=100, error="未安装 Point-E 本地后端；请运行安装器或在服务端配置生成器")
        return
    try:
        result = generate_from_image(job["imagePath"], job["maxVoxels"], progress, cancelled)
        if cancelled():
            with LOCK: job.update(status="cancelled", progress=job.get("progress", 0), error="用户取消了生成任务")
            return
        with LOCK: job.update(status="completed", progress=100, result=result)
    except PointEUnavailable as exc:
        with LOCK: job.update(status="cancelled" if cancelled() else "failed", progress=100, error=str(exc))
    except Exception as exc:
        with LOCK: job.update(status="failed", progress=100, error=f"Point-E 生成失败：{exc}")

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
