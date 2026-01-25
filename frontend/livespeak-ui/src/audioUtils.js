export async function startAudioCapture(onData) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                // Step 4: Disable all optimizations (Raw Audio)
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            }
        })

        // Try to create context at 16k. If browser refuses, it will use native rate.
        const audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
        })

        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)

        source.connect(processor)
        processor.connect(audioContext.destination)

        const sampleRate = audioContext.sampleRate
        console.log(`[Audio] Context sample rate: ${sampleRate}Hz`)

        let bufferAccumulator = []

        processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0)

            // If sample rate is not 16k, we need to resample.
            // Simple decimation/interpolation approach:
            let finalData = inputData

            if (sampleRate !== 16000) {
                // Basic resampling implementation
                const ratio = 16000 / sampleRate
                const newLength = Math.round(inputData.length * ratio)
                const resampled = new Float32Array(newLength)

                for (let i = 0; i < newLength; i++) {
                    // Linear interpolation
                    const originalIndex = i / ratio
                    const index1 = Math.floor(originalIndex)
                    const index2 = Math.min(Math.ceil(originalIndex), inputData.length - 1)
                    const weight = originalIndex - index1
                    resampled[i] = inputData[index1] * (1 - weight) + inputData[index2] * weight
                }
                finalData = resampled
            }

            // Convert Float32 to Int16
            const int16Data = new Int16Array(finalData.length)
            for (let i = 0; i < finalData.length; i++) {
                const s = Math.max(-1, Math.min(1, finalData[i]))
                int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
            }

            onData(int16Data.buffer)
        }

        return {
            stop: () => {
                source.disconnect()
                processor.disconnect()
                stream.getTracks().forEach((track) => track.stop())
                audioContext.close()
            },
        }
    } catch (error) {
        console.error("[Audio] Capture failed:", error)
        throw error
    }
}
