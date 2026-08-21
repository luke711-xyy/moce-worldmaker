# @moce/worldmaker-mcp

莫测造境的本地优先 MCP Bridge。它只监听 `127.0.0.1`，通过一次性配对码连接当前打开的浏览器标签页；MCP 不直接访问 Cloudflare、场景库、资产库或用户数据。

## 启动与配对

1. 在浏览器打开莫测造境，打开顶部的 AI/MCP 面板并复制配对码。
2. 在本机运行：

   ```bash
   npx -y @moce/worldmaker-mcp --pair-code 123456
   ```

3. 将同一条命令配置到 Codex 或 Claude Desktop。Bridge 会把工具调用转发到当前已配对的标签页。

配对码只在当前网页会话有效，浏览器关闭后失效；同一时间只允许一个浏览器标签页连接。Bridge 断线后会在本机范围内自动重连，超过一段时间仍未恢复时返回明确错误。

Claude Desktop 配置示例：

```json
{
  "mcpServers": {
    "moce-worldmaker": {
      "command": "npx",
      "args": ["-y", "@moce/worldmaker-mcp", "--pair-code", "123456"]
    }
  }
}
```

## 当前能力边界

- `moce_execute_voxel_program` 以整数体素坐标执行原子事务，支持基本体、加减、改色、拉伸、复制、变换、删除和装配；一次调用只产生一条撤销记录。
- 越界、碰撞、未知实体 ID 或预算超限时，整笔事务拒绝，不留下部分修改。
- 普通 MCP 编辑直接进入浏览器当前场景的撤销栈；云端场景库、云端资产库、账号和发布操作不开放给 MCP。
- `moce_generate_from_image` 只提交本机图片路径到本机 3D 服务；生成结果必须通过 `moce_confirm_generated_model` 明确导入当前场景。
- 复杂文字直接生成 3D 不属于首版范围；建议由 AI 先生成体素程序，或让用户提供参考图片。

## 本地 3D 后端

默认 Bridge 不安装模型权重。需要图生粗模型时，在本机执行：

```bash
npx -y @moce/worldmaker-mcp install-local-3d --create-venv --install-pointe
python3 packages/local-3d-service/server.py
```

服务会监听 `127.0.0.1:32124`。图片、点云和中间结果不上传 R2。首次真正生成时才会加载/下载 Point-E 权重，耗时和内存取决于本机 Python、PyTorch 和可用硬件；依赖未安装或加载失败会返回失败状态，不会伪装成成功。
