/**
 * WebSocket Client for LiveSpeak
 * 
 * Handles real-time communication with FastAPI backend
 * - Automatic reconnection
 * - Graceful error handling
 * - Message parsing
 */
export class WebSocketClient {
  constructor(url, config = {}) {
    this.url = url
    this.ws = null
    this.isConnecting = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.reconnectDelay = 3000

    this.onConnect = config.onConnect || (() => { })
    this.onDisconnect = config.onDisconnect || (() => { })
    this.onMessage = config.onMessage || (() => { })
    this.onError = config.onError || (() => { })

    this.connect()
  }

  connect() {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    this.isConnecting = true

    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log("[LiveSpeak] WebSocket connected")
        this.isConnecting = false
        this.reconnectAttempts = 0
        this.onConnect()
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          this.onMessage(message)
        } catch (e) {
          console.error("[LiveSpeak] Failed to parse WebSocket message:", e)
        }
      }

      this.ws.onerror = (error) => {
        console.error("[LiveSpeak] WebSocket error:", error)
        this.onError(error)
      }

      this.ws.onclose = () => {
        console.log("[LiveSpeak] WebSocket disconnected")
        this.isConnecting = false
        this.onDisconnect()
        this.attemptReconnect()
      }
    } catch (error) {
      console.error("[LiveSpeak] Failed to create WebSocket:", error)
      this.onError(error)
      this.attemptReconnect()
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("[LiveSpeak] Max reconnection attempts reached")
      return
    }

    this.reconnectAttempts++
    console.log(
      `[LiveSpeak] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms`
    )

    setTimeout(() => {
      this.connect()
    }, this.reconnectDelay)
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (typeof data === "string") {
        this.ws.send(data)
      } else if (data instanceof ArrayBuffer || data instanceof Blob || ArrayBuffer.isView(data)) {
        this.ws.send(data)
      } else {
        this.ws.send(JSON.stringify(data))
      }
    } else {
      console.warn("[LiveSpeak] WebSocket not connected")
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
