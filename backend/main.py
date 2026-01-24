import asyncio
import threading
import time
import numpy as np
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import scipy.io.wavfile as wavfile

# --- CONFIG ---
SAMPLE_RATE = 16000
WINDOW_SECONDS = 2.5
STRIDE_SECONDS = 0.5
MODEL_SIZE = "small.en"
BEAM_SIZE = 5

# --- GLOBAL STATE ---
model = None
is_running = False
debug_wav_saved = False

def load_model():
    global model
    print(f"[BACKEND] Loading Faster-Whisper ({MODEL_SIZE})...")
    # Step 6: Use exact settings
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    print("[BACKEND] Model loaded.")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    threading.Thread(target=load_model, daemon=True).start()
    yield
    # Shutdown logic (if needed) can go here

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/capture/start")
async def start_capture():
    global is_running, debug_wav_saved
    is_running = True
    debug_wav_saved = False # Reset debug save
    print("[BACKEND] Capture started")
    return {"status": "started"}

@app.post("/capture/stop")
async def stop_capture():
    global is_running
    is_running = False
    print("[BACKEND] Capture stopped")
    return {"status": "stopped"}

# Synchronization primitives
buffer_lock = asyncio.Lock()




def transcribe_sync(audio_data):
    if model is None: return ""
    
    # Step 3, 4, 6: Strict Settings
    segments, _ = model.transcribe(
        audio_data, 
        beam_size=BEAM_SIZE,
        language="en",          # Explicit Language
        task="transcribe",      # Explicit Task
        temperature=0.0,        # No random sampling
        vad_filter=False,       # Disable VAD optimization
        condition_on_previous_text=False, # Prevent cascading failures
        word_timestamps=True    # Per requirements
    )
    
    text = " ".join([s.text for s in segments]).strip()
    return text

@app.websocket("/ws/captions")
async def websocket_endpoint(websocket: WebSocket):
    global debug_wav_saved
    await websocket.accept()
    print("[BACKEND] WebSocket connected")

    # Shared State for this connection
    # Pre-allocate buffer for ~10 seconds
    buffer_capacity = int(SAMPLE_RATE * 10)
    audio_buffer = np.zeros(buffer_capacity, dtype=np.float32)
    
    # Mutual state container
    state = {
        "buffer_ptr": 0,
        "total_samples": 0
    }
    
    stop_event = asyncio.Event()
    buffer_lock = asyncio.Lock() # Local lock for this connection's buffer

    async def run_transcriber():
        last_transcribe_time = time.time()
        # Track the last valid text to "commit" it when silence occurs
        last_committed_text = ""
        last_interim_text = "" 
        
        print("[TRANSCRIPTION] Task started")
        
        while not stop_event.is_set():
            try:
                now = time.time()
                if now - last_transcribe_time < STRIDE_SECONDS:
                    await asyncio.sleep(0.05) # Check frequently for stop
                    continue
                
                if model is None:
                    await asyncio.sleep(0.5)
                    continue

                last_transcribe_time = now

                # 1. Snapshot Audio (Critical Section)
                segment_to_process = None
                
                async with buffer_lock:
                    ptr = state["buffer_ptr"]
                    
                    # Logic needs to match previous: Pull last WINDOW_SECONDS
                    window_samples_count = int(WINDOW_SECONDS * SAMPLE_RATE)
                    
                    if ptr >= window_samples_count:
                         # Simple case: we have enough contiguous data at the end
                         segment_to_process = audio_buffer[ptr - window_samples_count : ptr].copy()
                    else:
                        # Not enough data yet 
                        # Wait for at least 1.0s
                        if ptr < SAMPLE_RATE * 1.0:
                            continue
                        segment_to_process = audio_buffer[:ptr].copy()

                if segment_to_process is None:
                    continue

                # 2. Silence Detection & Finalization Logic
                max_amp = np.max(np.abs(segment_to_process))
                
                # If SILENCE detected
                if max_amp < 0.01:
                    # If we had some text pending that hasn't been committed yet, commit it now.
                    if last_interim_text and last_interim_text != last_committed_text:
                        print(f"[TRANSCRIPTION] Silence detected. Committing: '{last_interim_text}'")
                        if not stop_event.is_set():
                            await websocket.send_json({
                                "type": "segment_final",
                                "text": last_interim_text,
                                "timestamp": now
                            })
                        last_committed_text = last_interim_text
                        last_interim_text = "" # Reset interim
                        
                    continue # Skip transcription on silence

                # 3. CPU Bound Transcription (run in executor)
                # If not silent, we transcribe
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, transcribe_sync, segment_to_process)
                
                # Update partial tracking
                if result:
                    last_interim_text = result
                
                # 4. Send Result (Partial Update)
                if not stop_event.is_set():
                    try:
                        await websocket.send_json({
                            "type": "window_update",
                            "text": result,
                            "timestamp": now
                        })
                    except Exception as e:
                        print(f"[TRANSCRIPTION] Send failed (stopping): {e}")
                        stop_event.set()
                        break
            
            except Exception as e:
                print(f"[TRANSCRIPTION] Error: {e}")
                await asyncio.sleep(1)

        print("[TRANSCRIPTION] Task finished")

    # Start Transcriber
    transcriber_task = asyncio.create_task(run_transcriber())

    try:
        while True:
            message = await websocket.receive()
            
            if message["type"] == "websocket.disconnect":
                print("[RECEIVER] Disconnect received")
                break
            
            if "bytes" in message and is_running:
                chunk_bytes = message["bytes"]
                # Convert
                chunk_np = np.frombuffer(chunk_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                chunk_len = len(chunk_np)
                
                async with buffer_lock:
                    ptr = state["buffer_ptr"]
                    
                    # Overflow check (Shift Buffer Strategy)
                    if ptr + chunk_len > buffer_capacity:
                        # Keep last 5 seconds (2x Window)
                        keep_samples = int(WINDOW_SECONDS * 2 * SAMPLE_RATE)
                        if keep_samples > ptr: keep_samples = ptr
                        
                        # Shift
                        audio_buffer[:keep_samples] = audio_buffer[ptr - keep_samples : ptr]
                        state["buffer_ptr"] = keep_samples
                        ptr = keep_samples # Update local var for next line use
                    
                    # Write
                    audio_buffer[ptr : ptr + chunk_len] = chunk_np
                    state["buffer_ptr"] += chunk_len
                    state["total_samples"] += chunk_len
                    
    except WebSocketDisconnect:
        print("[RECEIVER] WebSocketDisconnect exception")
    except Exception as e:
        print(f"[RECEIVER] Error: {e}")
    finally:
        print("[BACKEND] WebSocket cleaning up...")
        stop_event.set() # Signal transcriber to stop
        await transcriber_task # Wait for it to exit
        print("[BACKEND] WebSocket closed completely")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
