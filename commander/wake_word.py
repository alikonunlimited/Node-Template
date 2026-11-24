#!/usr/bin/env python3
# AIKON-OS Wake Word Listener
# Listens for "Commander" then prints WAKE to stdout so Node.js knows to start recording
# Uses vosk (offline, free) — no cloud, no API key
# Install: pip install vosk sounddevice
# Model: download vosk-model-small-en-us from https://alphacephei.com/vosk/models
#        extract to D:\AIKON-OS\models\vosk-model-small-en-us

import sys
import os
import json
import queue
import sounddevice as sd

WAKE_WORD  = 'commander'
MODEL_PATH = os.path.join('D:\\AIKON-OS', 'models', 'vosk-model-small-en-us')
SAMPLE_RATE = 16000

def main():
    try:
        from vosk import Model, KaldiRecognizer
    except ImportError:
        print("VOSK_MISSING", flush=True)
        sys.exit(1)

    if not os.path.exists(MODEL_PATH):
        print(f"MODEL_MISSING:{MODEL_PATH}", flush=True)
        sys.exit(1)

    model = Model(MODEL_PATH)
    rec   = KaldiRecognizer(model, SAMPLE_RATE)
    q     = queue.Queue()

    def callback(indata, frames, time, status):
        q.put(bytes(indata))

    print("LISTENING", flush=True)

    with sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=8000,
                           dtype='int16', channels=1, callback=callback):
        while True:
            data = q.get()
            if rec.AcceptWaveform(data):
                result = json.loads(rec.Result())
                text   = result.get('text', '').lower()
                if WAKE_WORD in text:
                    print(f"WAKE:{text}", flush=True)
            else:
                partial = json.loads(rec.PartialResult()).get('partial','').lower()
                if WAKE_WORD in partial:
                    print(f"WAKE_PARTIAL:{partial}", flush=True)

if __name__ == '__main__':
    main()
