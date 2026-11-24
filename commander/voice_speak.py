#!/usr/bin/env python3
# AIKON-OS VoiceStudio — Commander TTS
# Uses pyttsx3 (offline, free, Windows SAPI5)
# Usage: python voice_speak.py "text to speak" [rate] [voice_index]

import sys
import pyttsx3

def speak(text, rate=175, voice_index=0):
    engine = pyttsx3.init()
    voices = engine.getProperty('voices')
    # Pick voice — prefer a male voice for Commander feel
    # voice_index 0 = first available, usually male on Windows
    if voices and voice_index < len(voices):
        engine.setProperty('voice', voices[voice_index].id)
    engine.setProperty('rate', rate)
    engine.setProperty('volume', 1.0)
    engine.say(text)
    engine.runAndWait()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python voice_speak.py <text> [rate] [voice_index]")
        sys.exit(1)
    text        = sys.argv[1]
    rate        = int(sys.argv[2]) if len(sys.argv) > 2 else 175
    voice_index = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    speak(text, rate, voice_index)
