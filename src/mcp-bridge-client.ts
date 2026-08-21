import type { BridgeRequest, BridgeResponse } from './mcp-protocol'

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

type Options = {
  pairCode: string
  onRequest: (method: string, params: unknown) => Promise<unknown>
  onStateChange?: (state: McpConnectionState, message?: string) => void
}

/** Browser side of the local MCP bridge. It never talks to Cloudflare. */
export class McpBridgeClient {
  private socket: WebSocket | null = null
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectStartedAt = 0
  private reconnectDelay = 500
  private readonly options: Options

  constructor(options: Options) { this.options = options }

  connect() {
    this.closed = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return
    this.reconnectStartedAt ||= Date.now()
    this.options.onStateChange?.('connecting')
    try {
      const socket = new WebSocket('ws://127.0.0.1:32123')
      this.socket = socket
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'browser_hello', pairCode: this.options.pairCode }))
        this.options.onStateChange?.('connecting')
      }
      socket.onmessage = (event) => this.handleMessage(String(event.data))
      socket.onerror = () => {
        if (!this.closed) this.options.onStateChange?.('reconnecting', '无法连接本地 MCP Bridge，正在重试…')
      }
      socket.onclose = () => {
        this.socket = null
        if (!this.closed) this.scheduleReconnect()
      }
    } catch (error) {
      if (!this.closed) this.scheduleReconnect(error instanceof Error ? error.message : '无法创建本地连接')
    }
  }

  disconnect() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.options.onStateChange?.('disconnected')
  }

  private scheduleReconnect(message = 'Bridge 已断开，正在重连…') {
    if (this.closed || this.reconnectTimer) return
    if (!this.reconnectStartedAt) this.reconnectStartedAt = Date.now()
    if (Date.now() - this.reconnectStartedAt >= 120_000) {
      this.options.onStateChange?.('error', '自动重连已超时，请重新打开 MCP 连接')
      return
    }
    this.options.onStateChange?.('reconnecting', message)
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private async handleMessage(raw: string) {
    let message: BridgeRequest | { type: string; message?: string }
    try { message = JSON.parse(raw) as BridgeRequest } catch { return }
    if (message.type === 'bridge_ready') {
      this.reconnectStartedAt = 0
      this.reconnectDelay = 500
      this.options.onStateChange?.('connected')
      return
    }
    if (message.type === 'bridge_error') { this.options.onStateChange?.('error', message.message); return }
    if (message.type !== 'rpc_request') return
    const request = message as BridgeRequest
    try {
      const result = await this.options.onRequest(request.method, request.params)
      this.send({ type: 'rpc_response', id: request.id, result })
    } catch (error) {
      this.send({ type: 'rpc_response', id: request.id, error: { code: 'browser_error', message: error instanceof Error ? error.message : '浏览器操作失败' } })
    }
  }

  private send(message: BridgeResponse) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }
}

export function makeMcpPairCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}
