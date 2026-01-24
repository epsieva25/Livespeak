import { useState, useEffect, useRef } from "react"
import CaptionStream from "./CaptionStream"
import { WebSocketClient } from "./socket"
import { startAudioCapture } from "./audioUtils"
import "./App.css"

/**
 * Main App Component
 * 
 * LiveSpeak - Real-time hybrid Edge + Cloud AI captioning system
 */
export default function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [captions, setCaptions] = useState([])
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const [wsClient, setWsClient] = useState(null)
  const [mockMode, setMockMode] = useState(false)
  const [audioCapture, setAudioCapture] = useState(null)
  const mockIntervalRef = useRef(null)

  // Initialize WebSocket connection
  useEffect(() => {
    // WebSocket URL - connect to FastAPI backend
    const wsUrl = import.meta.env.VITE_WS_URL || "ws://localhost:8000/ws/captions"

    const client = new WebSocketClient(wsUrl, {
      onConnect: () => {
        console.log("[LiveSpeak] WebSocket connected successfully")
        setIsConnected(true)
        setMockMode(false)
        setError(null)
        // Request initial stats
        client.send("get_stats")
      },
      onDisconnect: () => {
        console.log("[LiveSpeak] WebSocket disconnected")
        setIsConnected(false)
        setMockMode(true)
      },
      onMessage: (message) => {
        if (message.type === "caption") {
          // Handle Vosk partial vs final captions distinctly
          setCaptions((prev) => {
            const data = message.data
            // Treat 'sherpa' same as 'vosk' for live updates
            const isLive = data.source === "vosk" || data.source === "sherpa"
            const isFinal = !!data.is_final

            const newCaptions = [...prev]

            if (isLive && !isFinal) {
              // Live partial: update the most recent partial instead of appending endlessly
              const lastIdx = newCaptions.length - 1
              const last = newCaptions[lastIdx]

              if (last && (last.source === "vosk" || last.source === "sherpa") && !last.is_final) {
                newCaptions[lastIdx] = data
              } else {
                newCaptions.push(data)
              }
            } else {
              // Final Vosk caption or other sources: append as a new finalized caption
              newCaptions.push(data)
            }

            // Keep only last 100 captions
            return newCaptions.slice(-100)
          })
        } else if (message.type === "segment_final") {
          // Commit finalized segment from backend (silence detected)
          setCaptions((prev) => {
            const newCaptions = [...prev]

            // Remove any "window" (grey) captions since we are finalizing
            // This cleans up the partials so we don't have duplicates
            const cleaned = newCaptions.filter(c => c.source !== "window")

            cleaned.push({
              text: message.text,
              source: "window", // Keep source as window or change to 'finalized'
              is_final: true,   // Black text (History)
              timestamp: message.timestamp
            })

            return cleaned.slice(-100)
          })

        } else if (message.type === "window_update") {
          // New logic for Windowed Whisper
          setCaptions((prev) => {
            // We treat the "window" as a special 'live' caption that is constantly replaced
            // until we decide to 'finalize' it. 

            const newCaptions = [...prev]

            // Remove previous window partials to avoid duplication
            // We want to REPLACE the live window, not append
            const lastIdx = newCaptions.length - 1
            const last = newCaptions[lastIdx]

            const liveData = {
              text: message.text,
              source: "window",
              is_final: false, // Grey
              timestamp: message.timestamp
            }

            if (last && last.source === "window" && !last.is_final) {
              newCaptions[lastIdx] = liveData
            } else {
              newCaptions.push(liveData)
            }
            return newCaptions
          })
        } else if (message.type === "correction") {
          // Whisper correction: replace only the last finalized Vosk sentence,
          // never overwrite live partials.
          setCaptions((prev) => {
            const newCaptions = [...prev]
            const correction = message.data

            for (let i = newCaptions.length - 1; i >= 0; i--) {
              const c = newCaptions[i]
              if ((c.source === "vosk" || c.source === "sherpa") && c.is_final) {
                newCaptions[i] = {
                  ...c,
                  text: correction.text,
                  source: correction.source || "whisper",
                  is_final: true,
                }
                break
              }
            }

            return newCaptions
          })
        } else if (message.type === "stats") {
          setStats(message.data)
        } else if (message.type === "system_info") {
          console.log("[LiveSpeak] System info:", message.data)
        } else if (message.type === "error") {
          setError(message.message || "Unknown error")
        }
      },
      onError: (error) => {
        console.log("[LiveSpeak] WebSocket error - activating demo mode:", error)
        setMockMode(true)
        setIsConnected(false)
      },
    })

    setWsClient(client)

    return () => {
      client.disconnect()
      if (mockIntervalRef.current) {
        clearInterval(mockIntervalRef.current)
      }
    }
  }, [])

  // Mock mode caption generation (for demo/offline)
  useEffect(() => {
    if (isRunning && mockMode) {
      let captionIndex = 0
      const mockCaptions = [
        "Welcome to LiveSpeak real-time captioning system",
        "This is a demonstration of edge AI processing",
        "The system works fully offline using Faster-Whisper",
        "All processing happens in real-time with low latency",
      ]

      mockIntervalRef.current = setInterval(() => {
        const mockCaption = {
          text: mockCaptions[captionIndex % mockCaptions.length],
          source: Math.random() > 0.7 ? "cloud" : "edge",
          confidence: Math.random() * 0.3 + 0.7,
          noise_score: Math.random() * 0.3,
          timestamp: new Date().toISOString(),
        }
        setCaptions((prev) => [...prev.slice(-100), mockCaption])
        captionIndex++
      }, 2000)

      return () => {
        if (mockIntervalRef.current) {
          clearInterval(mockIntervalRef.current)
        }
      }
    }
  }, [isRunning, mockMode])

  const handleStart = async () => {
    if (mockMode) {
      setIsRunning(true)
      setError(null)
      return
    }

    try {
      // 1. Start Audio Capture first to ensure permissions
      const capture = await startAudioCapture((data) => {
        if (wsClient && wsClient.isConnected()) {
          wsClient.send(data)
        }
      })

      setAudioCapture(capture)

      // 2. Notify Backend
      const response = await fetch("http://localhost:8000/capture/start", {
        method: "POST",
      })
      if (response.ok) {
        setIsRunning(true)
        setError(null)
      } else {
        const data = await response.json()
        setError(data.detail || "Failed to start capture")
        capture.stop()
        setAudioCapture(null)
      }
    } catch (err) {
      console.error(err)
      setError(`Failed to start: ${err.message}`)
      setMockMode(true)
    }
  }

  const handleStop = async () => {
    // 1. Stop Audio
    if (audioCapture) {
      audioCapture.stop()
      setAudioCapture(null)
    }

    if (mockMode) {
      setIsRunning(false)
      if (mockIntervalRef.current) {
        clearInterval(mockIntervalRef.current)
      }
      return
    }

    // 2. Notify Backend
    try {
      const response = await fetch("http://localhost:8000/capture/stop", {
        method: "POST",
      })
      if (response.ok) {
        setIsRunning(false)
      } else {
        const data = await response.json()
        setError(data.detail || "Failed to stop capture")
      }
    } catch (err) {
      setError(`Failed to stop: ${err.message}`)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="header-title">
            <div
              className={`status-indicator ${isConnected ? "connected" : mockMode ? "demo" : "disconnected"}`}
            />
            <h1>LiveSpeak</h1>
          </div>
          <p className="header-subtitle">
            Production-Grade Real-Time Live Captioning System
          </p>
          <p className="header-status">
            {isConnected
              ? "✓ Connected to backend"
              : mockMode
                ? "⊘ Demo mode (backend offline)"
                : "⟳ Connecting..."}
          </p>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>⚠️ {error}</span>
        </div>
      )}

      <main className="app-main">
        <CaptionStream
          captions={captions}
          stats={stats}
          isRunning={isRunning}
          isConnected={isConnected}
          onStart={handleStart}
          onStop={handleStop}
        />
      </main>

      <footer className="app-footer">
        <p>
          Hybrid Edge + Cloud AI Architecture | L&T Techgium Hackathon | Enterprise-Ready
        </p>
      </footer>
    </div>
  )
}
