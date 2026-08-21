import { Bot, Copy, ExternalLink, X } from 'lucide-react'
import type { McpConnectionState } from './mcp-bridge-client'

type Props = { open: boolean; pairCode: string; state: McpConnectionState; message?: string; onClose: () => void }

export function McpPairingDialog({ open, pairCode, state, message, onClose }: Props) {
  if (!open) return null
  const command = `npx -y @moce/worldmaker-mcp --pair-code ${pairCode}`
  const status = state === 'connected' ? '已连接当前浏览器标签页' : state === 'reconnecting' ? '正在等待 Bridge 重新连接…' : state === 'error' ? (message ?? '连接失败') : '等待本地 MCP Bridge 连接…'
  return <div className="modal-backdrop mcp-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="dialog mcp-dialog" role="dialog" aria-modal="true" aria-label="MCP 连接">
      <div className="dialog-header"><div><Bot size={20}/><h2>AI / MCP 连接</h2><p>仅允许本机 AI 工具控制当前标签页</p></div><button className="icon-button" onClick={onClose} title="关闭"><X/></button></div>
      <div className="dialog-body">
        <div className={`mcp-status mcp-status-${state}`}><span className="mcp-status-dot"/>{status}</div>
        <p className="mcp-help">在 Codex 或 Claude Desktop 的 MCP 配置中启动本地 Bridge，然后把下面的一次性配对码交给它。</p>
        <label className="mcp-field-label">配对码</label>
        <div className="mcp-code">{pairCode}<button className="icon-button" title="复制配对码" onClick={() => void navigator.clipboard?.writeText(pairCode)}><Copy size={16}/></button></div>
        <label className="mcp-field-label">启动命令</label>
        <div className="mcp-command"><code>{command}</code><button className="icon-button" title="复制命令" onClick={() => void navigator.clipboard?.writeText(command)}><Copy size={16}/></button></div>
        <p className="mcp-security-note">连接只监听 127.0.0.1，浏览器关闭后配对码失效；MCP 不会直接访问云端场景库或资产库。</p>
        <a className="mcp-doc-link" href="https://github.com/luke711-xyy/moce-worldmaker" target="_blank" rel="noreferrer">查看 MCP 使用说明 <ExternalLink size={14}/></a>
      </div>
    </section>
  </div>
}
