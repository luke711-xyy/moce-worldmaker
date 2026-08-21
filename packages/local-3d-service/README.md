# 本地图生 3D 服务

这是 MCP 的可选本地后端。服务只监听 `127.0.0.1:32124`，不接受公网请求，也不会把图片、点云或模型中间结果上传到 R2。

## 安装与启动

推荐使用 MCP 包提供的隔离安装器：

```bash
npx -y @moce/worldmaker-mcp install-local-3d --create-venv --install-pointe
python3 packages/local-3d-service/server.py
```

也可以先只检查本机环境，不下载权重：

```bash
npx -y @moce/worldmaker-mcp install-local-3d
```

Point-E 依赖由用户明确安装；网页本身不会自动安装 Python、PyTorch 或模型权重。首次生成时，适配器会加载官方 image-conditioned base model 和 upsampler，可能需要下载权重并消耗较多内存。当前后端没有假成功回退：缺少依赖、权重或本机资源不足时，任务会以明确的 `failed` 状态结束。

## HTTP API

- `GET /health`：返回服务状态和 `backend`（`point-e` 或 `unavailable`）。
- `POST /jobs`：提交本机图片路径和 `maxVoxels`（1–256）。只接受 `.png`、`.jpg`、`.jpeg`、`.webp`。
- `GET /jobs/:id`：读取异步任务、进度和结果。
- `POST /jobs/:id/cancel`：请求取消任务。
- `POST /jobs/:id/confirm`：确认生成结果，供浏览器导入前完成状态闭环。

完成结果是低精度彩色体素草模：

```json
{
  "voxels": [{"x": 0, "y": 0, "z": 0, "color": [210, 120, 80]}],
  "bounds": {"x": 32, "y": 28, "z": 24},
  "voxelCount": 1234,
  "maxVoxels": 64,
  "surfaceOnly": true,
  "backend": "point-e"
}
```

点云坐标会归一化到非负体素空间；浏览器在用户确认后再根据场景放置点转换为当前工程的场景坐标。颜色由点云 RGB 采样后写入体素材质，不在本服务中上传或持久化用户图片。
