export type AuthUser = {
  id: string
  email: string
  status: 'active'
}

type AuthResponse = {
  ok: boolean
  user?: AuthUser
  message?: string
  devVerificationUrl?: string
}

export function setCloudAuthRequiredHandler(handler: (() => void) | null) {
  ;(globalThis as typeof globalThis & { __moceAuthRequired?: (() => void) | null }).__moceAuthRequired = handler
}

function notifyAuthRequired() {
  ;(globalThis as typeof globalThis & { __moceAuthRequired?: (() => void) | null }).__moceAuthRequired?.()
}

async function request<T>(path: string, init?: RequestInit, notifyOnUnauthorized = true): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init })
  if (!response.ok) {
    if (response.status === 401 && notifyOnUnauthorized) notifyAuthRequired()
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `认证请求失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

export function loadAuthUser(): Promise<{ user: AuthUser | null }> {
  return request<{ user: AuthUser | null }>('/api/auth/me', undefined, false)
}

export function registerAuthUser(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }, false)
}

export function loginAuthUser(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }, false)
}

export function logoutAuthUser(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }, false)
}
