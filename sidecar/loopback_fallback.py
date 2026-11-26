"""Opt-in, selected-output WASAPI diagnostic. No Electron/backend auto-switch."""

import argparse
import json
from math import gcd
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Thread
import wave

import numpy as np
from scipy.signal import resample_poly

SYSTEM_SOURCE = 1


class LoopbackError(RuntimeError):
    """Capture failed; a partial finalized diagnostic WAV may remain."""


def select_loopback(devices, name):
    matches = [d for d in devices if d.get("isLoopbackDevice")
               and d.get("name") == name and d.get("maxInputChannels", 0) > 0]
    if len(matches) != 1:
        raise LoopbackError("Choose exactly one currently listed loopback endpoint")
    return matches[0]


def encode_pcm(native, rate, channels):
    """Offline conversion at unity gain; never mixes microphone/source 0."""
    if rate <= 0 or channels <= 0 or len(native) % (4 * channels):
        raise LoopbackError("Invalid native float32 frame layout")
    samples = np.frombuffer(native, dtype="<f4").reshape(-1, channels)
    if not np.isfinite(samples).all():
        raise LoopbackError("Non-finite native audio samples")
    mono = samples.astype(np.float64).mean(axis=1)
    if not len(mono):
        return b""
    divisor = gcd(rate, 16000)
    converted = resample_poly(mono, 16000 // divisor, rate // divisor)
    converted = converted[:round(len(mono) * 16000 / rate)]
    clipped = np.clip(converted, -1, 1)
    scaled = np.where(clipped < 0, clipped * 32768, clipped * 32767)
    return np.rint(scaled).astype("<i2").tobytes()


def capture(pa, backend, device_name, output, seconds):
    if not np.isfinite(seconds) or not 1 <= seconds <= 30:
        raise LoopbackError("Duration must be between 1 and 30 seconds")
    device = select_loopback(list(pa.get_loopback_device_info_generator()), device_name)
    rate, channels = int(device["defaultSampleRate"]), int(device["maxInputChannels"])
    if not 8000 <= rate <= 192000 or not 1 <= channels <= 8:
        raise LoopbackError("Unsupported endpoint rate/channel configuration")
    limit = round(seconds * rate)
    chunks, errors, done = [], [], Event()
    received = 0

    def callback(data, frames, time_info, status):
        nonlocal received
        if status:
            errors.append("WASAPI reported a stream error or input overflow")
            done.set()
            return None, backend.paAbort
        if len(data) != frames * channels * 4:
            errors.append("WASAPI returned an incomplete native frame")
            done.set()
            return None, backend.paAbort
        count = min(frames, limit - received)
        chunks.append(data[:count * channels * 4])
        received += count
        if received >= limit:
            done.set()
            return None, backend.paComplete
        return None, backend.paContinue

    target = Path(output)
    # Exclusive creation preserves every previous recording, including failures.
    with target.open("xb") as file:
        with wave.open(file, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            try:
                with pa.open(format=backend.paFloat32, channels=channels, rate=rate,
                             input=True, input_device_index=device["index"],
                             frames_per_buffer=1024, stream_callback=callback):
                    done.wait(seconds + 2)
            finally:
                # The stream is closed before reading callback-owned buffers.
                wav.writeframes(encode_pcm(b"".join(chunks), rate, channels))
    if errors:
        raise LoopbackError(errors[0] + "; partial WAV finalized")
    if received < limit:
        raise LoopbackError("Endpoint stopped or delivered insufficient audio; partial WAV finalized")
    pcm = np.frombuffer(target.read_bytes()[44:], dtype="<i2")
    return {"source": SYSTEM_SOURCE, "device": device_name, "native_rate": rate,
            "native_channels": channels, "sample_rate": 16000, "channels": 1,
            "sample_width": 2, "samples": len(pcm), "duration_seconds": len(pcm) / 16000,
            "full_scale_samples": int(np.count_nonzero((pcm == -32768) | (pcm == 32767))),
            "peak": float(np.max(np.abs(pcm.astype(np.float64))) / 32768),
            "rms": float(np.sqrt(np.mean((pcm.astype(np.float64) / 32768) ** 2)))}


def run_dialog(action, seconds):
    """Local manual Start and visible recording status, without shell commands."""
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title("Vinxa selected-output audio test")
    root.geometry("570x230")
    root.attributes("-topmost", True)
    status = tk.StringVar(value=f"Record the selected earbuds output for {seconds:g} seconds.\n"
                          "Keep Windows on Realtek and Meet on OnePlus.\n"
                          "Ask the other person to speak and tell them this is recorded.")
    ttk.Label(root, textvariable=status, wraplength=530, padding=18).pack()
    results = Queue()
    running = False

    def worker():
        try:
            results.put((True, action()))
        except Exception as error:
            results.put((False, f"{type(error).__name__}: {error}"))

    def poll():
        nonlocal running
        try:
            ok, result = results.get_nowait()
        except Empty:
            root.after(100, poll)
            return
        running = False
        status.set("Recording saved. Listening and strict validation are still required."
                   if ok else f"Recording failed: {result}")
        print(json.dumps(result), flush=True)
        button.configure(text="Close", command=root.destroy, state="normal")

    def start():
        nonlocal running
        running = True
        button.configure(state="disabled")
        status.set(f"Recording selected output for {seconds:g} seconds…\n"
                   "Let the other person speak through Meet now.")
        Thread(target=worker, daemon=True).start()
        root.after(100, poll)

    button = ttk.Button(root, text="Start audio test", command=start)
    button.pack(pady=12)
    root.protocol("WM_DELETE_WINDOW", lambda: None if running else root.destroy())
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--device-name")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--seconds", type=float, default=20)
    args = parser.parse_args()
    import pyaudiowpatch as backend

    if args.list:
        with backend.PyAudio() as pa:
            print(json.dumps(list(pa.get_loopback_device_info_generator()), indent=2))
        return
    if not args.device_name or not args.output:
        parser.error("--device-name and --output are required; --list opens no stream")
    if not 1 <= args.seconds <= 30:
        parser.error("--seconds must be between 1 and 30")

    def action():
        with backend.PyAudio() as pa:
            return capture(pa, backend, args.device_name, args.output, args.seconds)

    run_dialog(action, args.seconds)


if __name__ == "__main__":
    main()
