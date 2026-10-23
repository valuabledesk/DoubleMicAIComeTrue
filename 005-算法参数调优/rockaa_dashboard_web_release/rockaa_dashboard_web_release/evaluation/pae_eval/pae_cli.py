#!/usr/bin/env python3
import argparse
import json
import math
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal
from scipy.io import wavfile


EPS = 1e-12
GAP_S = 0.5
PINK_NOISE_S = 2.0
MULTITONE_S = 2.0
MULTITONE_FREQUENCIES = (125, 250, 500, 1000, 2000, 4000, 6000)
CORRELATION_CONFIDENCE_THRESHOLD = 1.5
COHERENCE_THRESHOLD = 0.6
SNR_THRESHOLD_DB = 10.0
LOW_MIC_LEVEL_THRESHOLD_DBFS = -35.0
MULTITONE_RESIDUAL_THRESHOLD_DB = 10.0
MIC_PEAK_THRESHOLD_DBFS = -3.0
REFERENCE_SIMILARITY_THRESHOLD = 0.9


def _float_audio(data):
    if np.issubdtype(data.dtype, np.integer):
        scale = float(max(abs(np.iinfo(data.dtype).min), np.iinfo(data.dtype).max))
        return data.astype(np.float64) / scale
    return data.astype(np.float64)


def _read_wav(path):
    sample_rate, data = wavfile.read(path)
    data = _float_audio(data)
    if data.ndim == 1:
        data = data[:, None]
    return sample_rate, data


def _pink_noise(sample_rate, duration):
    frames = int(round(duration * sample_rate))
    frequencies = np.fft.rfftfreq(frames, 1.0 / sample_rate)
    amplitudes = np.zeros_like(frequencies)
    amplitudes[1:] = 1.0 / np.sqrt(frequencies[1:])
    phases = np.random.default_rng(0).uniform(0.0, 2.0 * np.pi, len(frequencies))
    noise = np.fft.irfft(amplitudes * np.exp(1j * phases), n=frames)
    return noise / max(float(np.max(np.abs(noise))), EPS) * 0.35


def _multitone(sample_rate, duration):
    frames = int(round(duration * sample_rate))
    time_s = np.arange(frames, dtype=np.float64) / sample_rate
    tones = sum(np.sin(2.0 * np.pi * frequency * time_s)
                for frequency in MULTITONE_FREQUENCIES)
    fade = signal.windows.tukey(frames, alpha=min(0.1, 0.08 / duration))
    return tones / max(float(np.max(np.abs(tones))), EPS) * fade * 0.4


def _segment_layout(sample_rate, duration, lead_s):
    sweep_start = int(round(lead_s * sample_rate))
    sweep_end = sweep_start + int(round(duration * sample_rate))
    pink_start = sweep_end + int(round(GAP_S * sample_rate))
    pink_end = pink_start + int(round(PINK_NOISE_S * sample_rate))
    multitone_start = pink_end + int(round(GAP_S * sample_rate))
    multitone_end = multitone_start + int(round(MULTITONE_S * sample_rate))
    return sweep_start, sweep_end, pink_start, pink_end, multitone_start, multitone_end


def generate_ess(sample_rate, duration, start_hz, end_hz, lead_s=1.0, tail_s=1.0):
    sweep_frames = int(round(duration * sample_rate))
    time_s = np.arange(sweep_frames, dtype=np.float64) / sample_rate
    ratio = end_hz / start_hz
    phase = 2.0 * np.pi * start_hz * duration / np.log(ratio) * (
        np.power(ratio, time_s / duration) - 1.0)
    sweep = np.sin(phase)
    fade_frames = min(int(0.02 * sample_rate), sweep_frames // 8)
    if fade_frames:
        fade = np.sin(np.linspace(0.0, np.pi / 2.0, fade_frames)) ** 2
        sweep[:fade_frames] *= fade
        sweep[-fade_frames:] *= fade[::-1]
    sweep *= 0.5
    lead = np.zeros(int(round(lead_s * sample_rate)), dtype=np.float64)
    gap = np.zeros(int(round(GAP_S * sample_rate)), dtype=np.float64)
    tail = np.zeros(int(round(tail_s * sample_rate)), dtype=np.float64)
    mono = np.concatenate([
        lead, sweep, gap, _pink_noise(sample_rate, PINK_NOISE_S), gap,
        _multitone(sample_rate, MULTITONE_S), tail,
    ])
    return np.column_stack([mono, mono])


def write_pcm16(path, sample_rate, data):
    pcm = np.clip(data, -1.0, 1.0)
    wavfile.write(path, sample_rate, np.round(pcm * 32767.0).astype(np.int16))


def _correlation_offset(reference, recorded, sample_rate, max_offset_s=4.0):
    correlation = signal.correlate(recorded, reference, mode="full", method="fft")
    lags = signal.correlation_lags(len(recorded), len(reference), mode="full")
    valid = (lags >= 0) & (lags <= int(max_offset_s * sample_rate))
    if not np.any(valid):
        raise ValueError("no non-negative correlation lag")
    values = np.abs(correlation[valid])
    valid_lags = lags[valid]
    peak_index = int(np.argmax(values))
    peak = float(values[peak_index])
    guard = max(1, int(0.02 * sample_rate))
    sidelobes = values.copy()
    sidelobes[max(0, peak_index - guard):peak_index + guard + 1] = 0.0
    confidence = peak / max(float(np.max(sidelobes)), EPS)
    return int(valid_lags[peak_index]), confidence


def _dbfs_rms(data):
    return 20.0 * np.log10(max(float(np.sqrt(np.mean(np.square(data)))), EPS))


def _channel_health(data):
    centered = data - np.mean(data)
    clipped = np.abs(data) >= 0.999
    max_run = 0
    run = 0
    for value in clipped:
        run = run + 1 if value else 0
        max_run = max(max_run, run)
    return {
        "peak_dbfs": 20.0 * np.log10(max(float(np.max(np.abs(data))), EPS)),
        "rms_dbfs": _dbfs_rms(centered),
        "dc_offset_mean": float(np.mean(data)),
        "clip_ratio": float(np.mean(clipped)),
        "clip_max_run_samples": int(max_run),
    }


def _aligned_similarity(reference, recorded):
    frames = min(len(reference), len(recorded))
    if frames <= 0:
        return 0.0
    reference = reference[:frames] - np.mean(reference[:frames])
    recorded = recorded[:frames] - np.mean(recorded[:frames])
    return abs(float(np.dot(reference, recorded))) / (
        np.linalg.norm(reference) * np.linalg.norm(recorded) + EPS)


def _ess_deconvolve(sweep, response, sample_rate, start_hz, end_hz, duration,
                    expected_delay):
    sweep_frames = len(sweep)
    time_s = np.arange(sweep_frames, dtype=np.float64) / sample_rate
    inverse = sweep[::-1] * np.exp(-time_s * np.log(end_hz / start_hz) / duration)
    convolution = signal.fftconvolve(response, inverse, mode="full")
    expected_peak = sweep_frames - 1 + expected_delay
    search_radius = int(0.02 * sample_rate)
    search_start = max(0, expected_peak - search_radius)
    search_end = min(len(convolution), expected_peak + search_radius + 1)
    peak_index = search_start + int(np.argmax(np.abs(convolution[search_start:search_end])))
    pre_frames = min(int(0.005 * sample_rate), peak_index)
    ir_start = peak_index - pre_frames
    ir_end = min(len(convolution), peak_index + int(1.0 * sample_rate))
    impulse = convolution[ir_start:ir_end].astype(np.float64)
    impulse /= max(float(np.max(np.abs(impulse))), EPS)
    direct_index = peak_index - ir_start
    nfft = 1 << int(math.ceil(math.log2(max(512, len(impulse) * 2))))
    transfer = np.fft.rfft(impulse, n=nfft)
    return impulse, transfer, nfft, direct_index


def _decay_metrics(impulse, sample_rate):
    energy = np.square(impulse)
    tail_start = max(1, int(len(energy) * 0.8))
    noise_power = float(np.median(energy[tail_start:]))
    corrected_energy = np.maximum(energy - noise_power, 0.0)
    schroeder = np.cumsum(corrected_energy[::-1])[::-1]
    decay_db = 10.0 * np.log10(np.maximum(schroeder / max(schroeder[0], EPS), EPS))
    peak_power = max(float(np.max(energy)), EPS)
    dynamic_range_db = 10.0 * np.log10(peak_power / max(noise_power, EPS))

    def fit_decay(high_db, low_db):
        if dynamic_range_db < abs(low_db) + 10.0:
            return None
        indices = np.flatnonzero((decay_db <= high_db) & (decay_db >= low_db))
        if len(indices) < 10:
            return None
        time_s = indices / sample_rate
        slope, intercept = np.polyfit(time_s, decay_db[indices], 1)
        if slope >= -EPS:
            return None
        predicted = slope * time_s + intercept
        residual = float(np.sum(np.square(decay_db[indices] - predicted)))
        total = float(np.sum(np.square(decay_db[indices] - np.mean(decay_db[indices]))))
        r_squared = 1.0 - residual / max(total, EPS)
        if r_squared < 0.9:
            return None
        return float(-60.0 / slope), float(slope), float(intercept), r_squared

    edt = fit_decay(0.0, -10.0)
    t20 = fit_decay(-5.0, -25.0)
    return decay_db, edt, t20, dynamic_range_db


def _pink_noise_metrics(far, mic, sample_rate):
    frequencies, coherence = signal.coherence(
        far, mic, fs=sample_rate, window="hann", nperseg=min(1024, len(far)))
    valid = (frequencies >= 100.0) & (frequencies <= min(7000.0, sample_rate * 0.45))
    return float(np.median(coherence[valid]))


def _multitone_signal_to_residual(data, sample_rate):
    window = signal.windows.hann(len(data), sym=False)
    spectrum = np.abs(np.fft.rfft(data * window)) ** 2
    frequencies = np.fft.rfftfreq(len(data), 1.0 / sample_rate)
    tone_mask = np.zeros(len(spectrum), dtype=bool)
    for tone in MULTITONE_FREQUENCIES:
        index = int(np.argmin(np.abs(frequencies - tone)))
        tone_mask[max(0, index - 1):min(len(tone_mask), index + 2)] = True
    valid = (frequencies >= 80.0) & (frequencies <= min(7200.0, sample_rate * 0.45))
    tone_energy = float(np.sum(spectrum[valid & tone_mask]))
    residual_energy = float(np.sum(spectrum[valid & ~tone_mask]))
    return 10.0 * np.log10(max(tone_energy, EPS) / max(residual_energy, EPS))


def analyze(source_path, capture_path, output_dir, duration=5.0,
            start_hz=80.0, end_hz=7200.0, language="en"):
    sample_rate, source = _read_wav(source_path)
    capture_rate, capture = _read_wav(capture_path)
    if capture_rate != sample_rate:
        raise ValueError(f"sample rate mismatch: {capture_rate} != {sample_rate}")
    if capture.shape[1] < 2:
        raise ValueError("PAE capture requires Mic ch0 and Far reference ch1")

    reference = np.mean(source, axis=1)
    mic = capture[:, 0]
    far = capture[:, 1]
    active = np.flatnonzero(np.abs(reference) > 1e-5)
    if not len(active):
        raise ValueError("PAE source contains no active stimulus")
    lead_s = active[0] / sample_rate
    sweep_start, sweep_end, pink_start, pink_end, multitone_start, multitone_end = (
        _segment_layout(sample_rate, duration, lead_s))
    sweep = reference[sweep_start:sweep_end]
    far_sweep_offset, far_confidence = _correlation_offset(sweep, far, sample_rate)
    mic_sweep_offset, mic_confidence = _correlation_offset(sweep, mic, sample_rate)
    far_offset = far_sweep_offset - sweep_start
    mic_offset = mic_sweep_offset - sweep_start
    if far_offset < 0 or mic_offset < 0:
        raise ValueError("PAE correlation produced an invalid source offset")
    relative_delay = mic_offset - far_offset

    available = min(len(reference), len(far) - far_offset, len(mic) - far_offset)
    if available < sample_rate:
        raise ValueError("aligned capture is too short")
    excitation = far[far_offset:far_offset + available]
    response = mic[far_offset:far_offset + available]
    sweep_frames = len(sweep)
    response_tail = int(1.0 * sample_rate)
    response_sweep = response[sweep_start:min(len(response), sweep_start + sweep_frames + response_tail)]
    impulse, transfer, nfft, direct_index = _ess_deconvolve(
        sweep, response_sweep, sample_rate, start_hz, end_hz, duration, relative_delay)
    direct_decay_db, edt, t20, decay_dynamic_range = _decay_metrics(
        impulse[direct_index:], sample_rate)
    decay_db = np.full(len(impulse), np.nan, dtype=np.float64)
    decay_db[direct_index:] = direct_decay_db

    frequencies = np.fft.rfftfreq(nfft, 1.0 / sample_rate)
    magnitude_db = 20.0 * np.log10(np.maximum(np.abs(transfer), EPS))
    phase = np.unwrap(np.angle(transfer))
    group_delay_ms = -np.gradient(phase, 2.0 * np.pi * frequencies, edge_order=1) * 1000.0
    group_delay_ms -= direct_index * 1000.0 / sample_rate
    valid_band = (frequencies >= 80.0) & (frequencies <= min(7200.0, sample_rate * 0.45))
    normalized_magnitude = magnitude_db - np.median(magnitude_db[valid_band])
    response_span = float(np.percentile(normalized_magnitude[valid_band], 95)
                          - np.percentile(normalized_magnitude[valid_band], 5))
    pre_frames = min(far_offset, sample_rate)
    noise_rms_dbfs = _dbfs_rms(mic[:pre_frames]) if pre_frames else None
    segment_guard = int(0.1 * sample_rate)
    mic_shift = max(relative_delay, 0)
    pink_far = excitation[pink_start + segment_guard:pink_end - segment_guard]
    pink_mic = response[pink_start + mic_shift + segment_guard:
                       pink_end + mic_shift - segment_guard]
    multitone_far = excitation[multitone_start + segment_guard:
                               multitone_end - segment_guard]
    multitone_mic = response[multitone_start + mic_shift + segment_guard:
                             multitone_end + mic_shift - segment_guard]
    segment_frames = min(len(pink_far), len(pink_mic))
    pink_coherence = _pink_noise_metrics(
        pink_far[:segment_frames], pink_mic[:segment_frames], sample_rate)
    pink_mic_rms = _dbfs_rms(pink_mic[:segment_frames])
    pink_noise_snr = pink_mic_rms - noise_rms_dbfs if noise_rms_dbfs is not None else None
    segment_frames = min(len(multitone_far), len(multitone_mic))
    far_multitone_srr = _multitone_signal_to_residual(
        multitone_far[:segment_frames], sample_rate)
    mic_multitone_srr = _multitone_signal_to_residual(
        multitone_mic[:segment_frames], sample_rate)
    aligned_frames = min(len(reference), len(excitation))
    far_similarity = _aligned_similarity(
        reference[:aligned_frames], excitation[:aligned_frames])
    mic_start = max(relative_delay, 0)
    mic_aligned = response[mic_start:mic_start + aligned_frames]
    mic_similarity = _aligned_similarity(reference[:len(mic_aligned)], mic_aligned)
    relative_gain_db = _dbfs_rms(mic_aligned) - _dbfs_rms(excitation[:len(mic_aligned)])
    mic_health = _channel_health(response)
    far_health = _channel_health(excitation)
    source_health = _channel_health(reference)

    os.makedirs(output_dir, exist_ok=True)
    metrics = {
        "sample_rate_hz": sample_rate,
        "mic_channel": 0,
        "far_reference_channel": 1,
        "far_offset_ms": far_offset * 1000.0 / sample_rate,
        "mic_offset_ms": mic_offset * 1000.0 / sample_rate,
        "mic_to_far_latency_ms": relative_delay * 1000.0 / sample_rate,
        "far_correlation_confidence": far_confidence,
        "mic_correlation_confidence": mic_confidence,
        "mic_source_similarity": mic_similarity,
        "far_source_similarity": far_similarity,
        "mic_to_far_gain_db": relative_gain_db,
        "mic_health": mic_health,
        "far_health": far_health,
        "source_health": source_health,
        "rir_direct_ms": relative_delay * 1000.0 / sample_rate,
        "frequency_response_p5_p95_span_db": response_span,
        "mic_rms_dbfs": _dbfs_rms(response),
        "far_rms_dbfs": _dbfs_rms(excitation),
        "noise_rms_dbfs": noise_rms_dbfs,
        "decay_dynamic_range_db": decay_dynamic_range,
        "pink_noise_coherence_median": pink_coherence,
        "pink_noise_mic_rms_dbfs": pink_mic_rms,
        "pink_noise_snr_db": pink_noise_snr,
        "far_multitone_signal_to_residual_db": far_multitone_srr,
        "mic_multitone_signal_to_residual_db": mic_multitone_srr,
        "edt_s": edt[0] if edt else None,
        "t20_extrapolated_s": t20[0] if t20 else None,
        "scope": "Uncalibrated in-device ESS/RIR screening; not an ISO 3382 certification.",
    }
    metrics["diagnostic_flags"] = _diagnostic_flags(metrics)
    with open(os.path.join(output_dir, "metrics.json"), "w", encoding="utf-8") as stream:
        json.dump(metrics, stream, ensure_ascii=False, indent=2)

    _plot_capture(output_dir, capture, sample_rate, far_offset, mic_offset)
    _plot_capture_spectrogram(output_dir, response, excitation, sample_rate)
    _plot_impulse(output_dir, impulse, decay_db, sample_rate, direct_index)
    _plot_frequency(output_dir, frequencies, normalized_magnitude, valid_band)
    _plot_group_delay(output_dir, frequencies, group_delay_ms, valid_band)
    _plot_waterfall(output_dir, impulse, sample_rate)
    _plot_diagnostic_map(output_dir, metrics)
    _write_report(output_dir, metrics, language)
    return metrics


def _plot_capture(output_dir, capture, sample_rate, far_offset, mic_offset):
    time_s = np.arange(len(capture)) / sample_rate
    fig, axes = plt.subplots(2, 1, figsize=(12, 5), sharex=True)
    axes[0].plot(time_s, capture[:, 0], linewidth=0.5, color="#1f77b4")
    axes[0].axvline(mic_offset / sample_rate, color="#d62728", linestyle="--")
    axes[0].set_ylabel("Mic ch0")
    axes[1].plot(time_s, capture[:, 1], linewidth=0.5, color="#2ca02c")
    axes[1].axvline(far_offset / sample_rate, color="#d62728", linestyle="--")
    axes[1].set_ylabel("Far ch1")
    axes[1].set_xlabel("Time (s)")
    fig.suptitle("PAE Capture Overview")
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "capture_overview.png"), dpi=140)
    plt.close(fig)


def _plot_capture_spectrogram(output_dir, mic, far, sample_rate):
    fig = plt.figure(figsize=(12, 7))
    grid = fig.add_gridspec(2, 2, width_ratios=(1.0, 0.025),
                            hspace=0.12, wspace=0.08)
    axes = (fig.add_subplot(grid[0, 0]), fig.add_subplot(grid[1, 0]))
    color_axis = fig.add_subplot(grid[:, 1])
    for axis, data, title in zip(axes, (mic, far), ("Mic ch0", "Far Reference ch1")):
        frequencies, time_s, spectrum = signal.stft(
            data, sample_rate, window="hann", nperseg=512, noverlap=384,
            nfft=1024, boundary=None)
        spectrum_db = 20.0 * np.log10(np.maximum(np.abs(spectrum), EPS))
        keep = frequencies <= min(7200.0, sample_rate / 2.0)
        image = axis.pcolormesh(time_s, frequencies[keep], spectrum_db[keep],
                                shading="auto", cmap="viridis")
        axis.set_ylabel(f"{title}\nFrequency (Hz)")
    axes[-1].set_xlabel("Time aligned to Far (s)")
    fig.colorbar(image, cax=color_axis, label="Magnitude (dB)")
    fig.suptitle("Aligned Mic / Far Spectrograms")
    fig.subplots_adjust(left=0.1, right=0.92, bottom=0.08, top=0.92)
    fig.savefig(os.path.join(output_dir, "capture_spectrogram.png"), dpi=140)
    plt.close(fig)


def _plot_impulse(output_dir, impulse, decay_db, sample_rate, direct_index):
    time_ms = (np.arange(len(impulse)) - direct_index) * 1000.0 / sample_rate
    envelope = np.abs(signal.hilbert(impulse))
    envelope_db = 20.0 * np.log10(np.maximum(envelope / max(np.max(envelope), EPS), EPS))
    fig, axes = plt.subplots(2, 1, figsize=(12, 6), sharex=True)
    axes[0].plot(time_ms, impulse, linewidth=0.7)
    axes[0].axvline(0.0, color="#d62728", linestyle="--",
                    label="correlation-aligned direct arrival")
    axes[0].set_ylabel("Amplitude")
    axes[0].set_title("Estimated Room Impulse Response")
    axes[0].legend()
    axes[1].plot(time_ms, envelope_db, label="ETC", linewidth=0.8)
    axes[1].plot(time_ms, decay_db, label="Schroeder decay", linewidth=0.8)
    axes[1].set_ylim(-80, 5)
    axes[1].set_ylabel("dB")
    axes[1].set_xlabel("Time (ms)")
    axes[1].legend()
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "impulse_etc.png"), dpi=140)
    plt.close(fig)


def _plot_frequency(output_dir, frequencies, magnitude_db, valid_band):
    fig, axis = plt.subplots(figsize=(12, 4))
    axis.semilogx(frequencies[valid_band], magnitude_db[valid_band], linewidth=0.9)
    axis.axhline(0.0, color="#777777", linewidth=0.7)
    axis.set_xlabel("Frequency (Hz)")
    axis.set_ylabel("Relative magnitude (dB)")
    axis.set_title("Acoustic Transfer Frequency Response")
    axis.grid(True, which="both", alpha=0.25)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "frequency_response.png"), dpi=140)
    plt.close(fig)


def _plot_group_delay(output_dir, frequencies, group_delay_ms, valid_band):
    values = group_delay_ms[valid_band]
    finite = np.isfinite(values)
    limit = np.percentile(np.abs(values[finite]), 95) if np.any(finite) else 10.0
    limit = max(2.0, min(float(limit), 100.0))
    fig, axis = plt.subplots(figsize=(12, 4))
    axis.semilogx(frequencies[valid_band], values, linewidth=0.8)
    axis.set_ylim(-limit, limit)
    axis.set_xlabel("Frequency (Hz)")
    axis.set_ylabel("Group delay (ms)")
    axis.set_title("Acoustic Transfer Group Delay")
    axis.grid(True, which="both", alpha=0.25)
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "group_delay.png"), dpi=140)
    plt.close(fig)


def _plot_waterfall(output_dir, impulse, sample_rate):
    frequencies, time_s, spectrum = signal.stft(
        impulse, sample_rate, window="hann", nperseg=512, noverlap=448, nfft=1024)
    spectrum_db = 20.0 * np.log10(np.maximum(np.abs(spectrum), EPS))
    spectrum_db -= np.max(spectrum_db)
    keep = frequencies <= min(7200.0, sample_rate / 2.0)
    fig, axis = plt.subplots(figsize=(12, 5))
    image = axis.pcolormesh(time_s * 1000.0, frequencies[keep], spectrum_db[keep],
                            shading="auto", vmin=-70, vmax=0, cmap="magma")
    axis.set_xlabel("Time after impulse (ms)")
    axis.set_ylabel("Frequency (Hz)")
    axis.set_title("RIR Time-Frequency Decay")
    fig.colorbar(image, ax=axis, label="Relative level (dB)")
    fig.tight_layout()
    fig.savefig(os.path.join(output_dir, "waterfall.png"), dpi=140)
    plt.close(fig)


def _annotate_diagnostic_point(axis, x_value, y_value, text):
    display_point = axis.transData.transform((x_value, y_value))
    axis_point = axis.transAxes.inverted().transform(display_point)
    horizontal = -6 if axis_point[0] >= 0.72 else 6
    vertical = -6 if axis_point[1] >= 0.82 else 6
    return axis.annotate(text, (x_value, y_value), xytext=(horizontal, vertical),
                         textcoords="offset points", fontsize=8,
                         ha="right" if horizontal < 0 else "left",
                         va="top" if vertical < 0 else "bottom",
                         annotation_clip=True,
                         bbox={"boxstyle": "round,pad=0.2", "fc": "white", "alpha": 0.8})


def _plot_diagnostic_map(output_dir, metrics):
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))

    axis = axes[0, 0]
    residual = metrics["mic_multitone_signal_to_residual_db"]
    peak = metrics["mic_health"]["peak_dbfs"]
    axis.axvspan(-10, MULTITONE_RESIDUAL_THRESHOLD_DB, color="#ef4444", alpha=0.12)
    axis.axhspan(MIC_PEAK_THRESHOLD_DBFS, 0, color="#f59e0b", alpha=0.14)
    axis.axvline(MULTITONE_RESIDUAL_THRESHOLD_DB, color="#dc2626", linestyle="--", label="Residual threshold: 10 dB")
    axis.axhline(MIC_PEAK_THRESHOLD_DBFS, color="#d97706", linestyle="--", label="Peak threshold: -3 dBFS")
    axis.scatter(residual, peak, color="#2563eb", s=70, zorder=5)
    axis.set_xlim(-10, max(30, residual + 5))
    axis.set_ylim(-60, 0)
    _annotate_diagnostic_point(axis, residual, peak, f"{residual:.1f} dB, {peak:.1f} dBFS")
    axis.set_xlabel("Mic multitone signal / residual (dB, higher is better)")
    axis.set_ylabel("Mic peak (dBFS, lower avoids clipping)")
    axis.set_title("Nonlinearity / Overdrive")
    axis.legend(fontsize=8, loc="lower right")

    axis = axes[0, 1]
    coherence = metrics["pink_noise_coherence_median"]
    confidence = max(metrics["mic_correlation_confidence"], 0.05)
    axis.axvspan(0, COHERENCE_THRESHOLD, color="#ef4444", alpha=0.12)
    axis.axhspan(0.05, CORRELATION_CONFIDENCE_THRESHOLD, color="#ef4444", alpha=0.12)
    axis.axvline(COHERENCE_THRESHOLD, color="#dc2626", linestyle="--", label="Coherence threshold: 0.6")
    axis.axhline(CORRELATION_CONFIDENCE_THRESHOLD, color="#d97706", linestyle="--", label="Correlation threshold: 1.5")
    axis.scatter(coherence, confidence, color="#2563eb", s=70, zorder=5)
    axis.set_xlim(0, 1.02)
    axis.set_yscale("log")
    axis.set_ylim(0.05, max(100, confidence * 1.5))
    _annotate_diagnostic_point(axis, coherence, confidence, f"{coherence:.3f}, {confidence:.2f}")
    axis.set_xlabel("Pink-noise median coherence (higher is better)")
    axis.set_ylabel("Mic correlation confidence (higher is better)")
    axis.set_title("Acoustic Coupling Stability")
    axis.legend(fontsize=8, loc="upper left")

    axis = axes[1, 0]
    mic_level = metrics["pink_noise_mic_rms_dbfs"]
    snr = metrics["pink_noise_snr_db"]
    plotted_snr = -10 if snr is None else snr
    display_snr = min(max(plotted_snr, -20), 60)
    axis.fill_between([-80, LOW_MIC_LEVEL_THRESHOLD_DBFS], -20, SNR_THRESHOLD_DB, color="#ef4444", alpha=0.12)
    axis.axvline(LOW_MIC_LEVEL_THRESHOLD_DBFS, color="#d97706", linestyle="--", label="Low-level threshold: -35 dBFS")
    axis.axhline(SNR_THRESHOLD_DB, color="#dc2626", linestyle="--", label="SNR threshold: 10 dB")
    axis.scatter(mic_level, display_snr, color="#2563eb", s=70, zorder=5)
    snr_label = "N/A" if snr is None else f"{snr:.1f} dB"
    axis.set_xlim(-80, 0)
    axis.set_ylim(-20, 65)
    _annotate_diagnostic_point(axis, mic_level, display_snr, f"{mic_level:.1f} dBFS, {snr_label}")
    axis.set_xlabel("Pink-noise Mic RMS (dBFS)")
    axis.set_ylabel("SNR margin (dB, higher is better)")
    axis.set_title("Mic Gain / Noise Margin")
    axis.legend(fontsize=8, loc="upper left")

    axis = axes[1, 1]
    similarity = metrics["far_source_similarity"]
    relative_gain = metrics["mic_to_far_gain_db"]
    axis.axvspan(0, REFERENCE_SIMILARITY_THRESHOLD, color="#ef4444", alpha=0.12)
    axis.axvline(REFERENCE_SIMILARITY_THRESHOLD, color="#dc2626", linestyle="--", label="Similarity threshold: 0.9")
    axis.axhline(0, color="#94a3b8", linewidth=1)
    axis.scatter(similarity, relative_gain, color="#2563eb", s=70, zorder=5)
    axis.set_xlim(0, 1.02)
    axis.set_ylim(min(-40, relative_gain - 5), max(20, relative_gain + 5))
    _annotate_diagnostic_point(axis, similarity, relative_gain, f"{similarity:.3f}, {relative_gain:.1f} dB")
    axis.set_xlabel("Far / source similarity (higher is better)")
    axis.set_ylabel("Mic relative to Far gain (dB)")
    axis.set_title("Reference Path / Gain Balance")
    axis.legend(fontsize=8, loc="lower right")

    for axis in axes.flat:
        axis.grid(True, alpha=0.2)
    fig.suptitle("Evaluation Diagnostic Decision Map\nBlue point: current measurement; shaded area: review region")
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(os.path.join(output_dir, "diagnostic_map.png"), dpi=140)
    plt.close(fig)


def _format_metric(value, suffix="", digits=3, unavailable="unavailable"):
    return unavailable if value is None else f"{value:.{digits}f}{suffix}"


def _customer_recommendations(metrics, warning_keys, language):
    recommendations = []
    if "clipping" in warning_keys or metrics["mic_health"]["peak_dbfs"] > MIC_PEAK_THRESHOLD_DBFS:
        recommendations.append("mic_gain_down")
    elif "snr" in warning_keys and metrics["pink_noise_mic_rms_dbfs"] < LOW_MIC_LEVEL_THRESHOLD_DBFS:
        recommendations.append("mic_gain_up")
    if "multitone" in warning_keys:
        recommendations.append("speaker_structure")
    if "coherence" in warning_keys or "correlation" in warning_keys:
        recommendations.append("mic_sealing")
    if "reference" in warning_keys:
        recommendations.append("reference")
    if not recommendations:
        recommendations.append("keep_and_verify")

    text = {
        "zh": {
            "mic_gain_down": "降低 Mic 模拟/数字增益；若仍削波或失真，再适度降低 SPK 增益。",
            "mic_gain_up": "在不削波的前提下适度提高 Mic 增益，并降低底噪和环境噪声。",
            "speaker_structure": "建议优先排查：先降低 SPK 增益排除喇叭过驱；同时用缓冲材料固定喇叭和壳体，减少共振与固体传振。",
            "mic_sealing": "建议优先排查：加强 Mic 除进音孔外的气密性，并隔离 SPK 经壳体、支架和 PCB 泄漏到 Mic 的振动能量。",
            "reference": "检查 Far Reference 回采通路、声道映射和电平，确保其与实际播放信号一致。",
            "keep_and_verify": "保持当前结构和增益配比，再用不同音量与摆位复测，确认结果具有重复性。",
        },
        "en": {
            "mic_gain_down": "Reduce analog/digital Mic gain; if clipping or distortion remains, reduce SPK gain moderately.",
            "mic_gain_up": "Increase Mic gain moderately without clipping, and reduce system and ambient noise.",
            "speaker_structure": "Lower SPK gain first to rule out overdrive; secure and cushion the speaker and enclosure to reduce resonance and structure-borne vibration.",
            "mic_sealing": "Seal the Mic except for its acoustic port, and isolate vibration leaking from the SPK through the enclosure, brackets, and PCB.",
            "reference": "Check the Far Reference routing, channel mapping, and level so it matches the actual playback signal.",
            "keep_and_verify": "Keep the current structure and gain balance, then repeat at different volumes and placements to confirm repeatability.",
        },
    }[language]
    return [text[key] for key in recommendations[:3]]


def _diagnostic_flags(metrics):
    warning_keys = []
    if metrics["mic_correlation_confidence"] < CORRELATION_CONFIDENCE_THRESHOLD:
        warning_keys.append("correlation")
    if metrics["pink_noise_coherence_median"] < COHERENCE_THRESHOLD:
        warning_keys.append("coherence")
    if metrics["pink_noise_snr_db"] is not None and metrics["pink_noise_snr_db"] < SNR_THRESHOLD_DB:
        warning_keys.append("snr")
    if metrics["mic_multitone_signal_to_residual_db"] < MULTITONE_RESIDUAL_THRESHOLD_DB:
        warning_keys.append("multitone")
    if metrics["mic_health"]["clip_ratio"] > 0.0:
        warning_keys.append("clipping")
    if metrics["far_source_similarity"] < REFERENCE_SIMILARITY_THRESHOLD:
        warning_keys.append("reference")
    return warning_keys


def _write_report(output_dir, metrics, language):
    warning_keys = metrics.get("diagnostic_flags", _diagnostic_flags(metrics))
    if language == "zh":
        unavailable = "不可用"
        if warning_keys:
            findings = "、".join({
                "correlation": "Mic 相关峰不够突出",
                "coherence": "宽带相干性偏低",
                "snr": "粉红噪声信噪余量不足",
                "multitone": "多音残差偏高",
                "clipping": "Mic 存在削波",
                "reference": "Far 与播放源一致性不足",
            }[key] for key in warning_keys)
            verdict = f"发现 {len(warning_keys)} 项需要优化，优先调整结构传振和 Mic/SPK 增益配比。"
        else:
            findings = "未发现预设筛查关注项"
            verdict = "当前结构和 Mic/SPK 增益配比未发现明显异常。"
        recommendations = _customer_recommendations(metrics, warning_keys, "zh")
        lines = [
            "# 评估测试报告",
            "",
            "## 总结",
            f"- 结论：{verdict}",
            f"- 测试发现：{findings}。",
            "",
            "## 优化建议",
            *[f"- {item}" for item in recommendations],
            "- 建议按上述顺序逐项调整，每次只改变一个变量并重新评估，以确认改善来源。",
            "",
            "## 判定依据图",
            "- 蓝点为本次实测值，虚线为触发门限，浅红区域为建议复核区域。",
            "- 四个坐标分别对应非线性/过驱、声学耦合稳定性、Mic 增益/噪声余量、Far 回采/增益配比。",
            "- 风险区域只用于定位优先排查方向，不等同于结构问题的唯一因果结论。",
            "![诊断判定图](diagnostic_map.png)",
            "",
            "## 测试范围",
            "- 16 kHz、未校准的设备内声学筛查。",
            "- 录音通道角色：ch0 为 Mic，ch1 为同步 Far Reference。",
            "- 结果包含喇叭、箱体、房间、麦克风和采集链路的共同影响。",
            "- 本报告不是 ISO 3382 认证，也不是绝对声压级测量。",
            "",
            "## 对齐与电平",
            f"- Mic 相对 Far：{metrics['mic_to_far_latency_ms']:.3f} 毫秒",
            f"- 相关对齐的 RIR 直达声：{metrics['rir_direct_ms']:.3f} 毫秒",
            f"- Mic/Far 相关置信度：{metrics['mic_correlation_confidence']:.3f} / {metrics['far_correlation_confidence']:.3f}",
            f"- Mic/Far 均方根电平：{metrics['mic_rms_dbfs']:.2f} / {metrics['far_rms_dbfs']:.2f} dBFS",
            f"- 激励前噪声均方根：{_format_metric(metrics['noise_rms_dbfs'], ' dBFS', 2, unavailable)}",
            "",
            "## Mic / Far 通道健康度",
            f"- Mic ch0：峰值 {metrics['mic_health']['peak_dbfs']:.2f} dBFS，"
            f"RMS {metrics['mic_health']['rms_dbfs']:.2f} dBFS，"
            f"削波比例 {metrics['mic_health']['clip_ratio']:.6f}，"
            f"DC {metrics['mic_health']['dc_offset_mean']:.6f}",
            f"- Far ch1：峰值 {metrics['far_health']['peak_dbfs']:.2f} dBFS，"
            f"RMS {metrics['far_health']['rms_dbfs']:.2f} dBFS，"
            f"削波比例 {metrics['far_health']['clip_ratio']:.6f}，"
            f"DC {metrics['far_health']['dc_offset_mean']:.6f}",
            f"- 播放源：峰值 {metrics['source_health']['peak_dbfs']:.2f} dBFS，"
            f"RMS {metrics['source_health']['rms_dbfs']:.2f} dBFS，"
            f"削波比例 {metrics['source_health']['clip_ratio']:.6f}",
            f"- Mic/Far 相对增益：{metrics['mic_to_far_gain_db']:.2f} dB",
            f"- Mic/Far 与播放源一致性：{metrics['mic_source_similarity']:.3f} / "
            f"{metrics['far_source_similarity']:.3f}",
            "- Far 中与播放源一致的近满幅样本属于参考内容，不等同于 Mic 削波。",
            "",
            "## 声学指标",
            f"- 频响 P5-P95 展宽：{metrics['frequency_response_p5_p95_span_db']:.2f} dB",
            f"- RIR 峰值至尾部噪声动态范围：{metrics['decay_dynamic_range_db']:.2f} dB",
            f"- 粉红噪声中位相干度：{metrics['pink_noise_coherence_median']:.3f}",
            f"- 粉红噪声 Mic 电平/信噪余量：{metrics['pink_noise_mic_rms_dbfs']:.2f} dBFS / "
            f"{_format_metric(metrics['pink_noise_snr_db'], ' dB', 2, unavailable)}",
            f"- Mic/Far 多音信号残差比：{metrics['mic_multitone_signal_to_residual_db']:.2f} / {metrics['far_multitone_signal_to_residual_db']:.2f} dB",
            f"- EDT 估计：{_format_metric(metrics['edt_s'], ' 秒', unavailable=unavailable)}",
            f"- T20 外推估计：{_format_metric(metrics['t20_extrapolated_s'], ' 秒', unavailable=unavailable)}",
            "- 衰减动态范围或线性拟合质量不足时不输出 EDT/T20，避免噪声底造成误判。",
            "- 即使数值可用，也仍是筛查结果；标准测量需要校准电平、几何位置和重复测点。",
            "",
            "## 录音概览",
            "![录音概览](capture_overview.png)",
            "",
            "## Mic / Far 语谱图",
            "![Mic / Far 语谱图](capture_spectrogram.png)",
            "",
            "## 脉冲响应与能量时间曲线",
            "![脉冲响应与能量时间曲线](impulse_etc.png)",
            "",
            "## 频率响应",
            "![频率响应](frequency_response.png)",
            "",
            "## 群时延",
            "![群时延](group_delay.png)",
            "",
            "## 时频衰减",
            "![时频衰减](waterfall.png)",
        ]
    else:
        if warning_keys:
            findings = ", ".join({
                "correlation": "weak Mic correlation peak",
                "coherence": "low broadband coherence",
                "snr": "insufficient pink-noise SNR margin",
                "multitone": "high multitone residual",
                "clipping": "Mic clipping",
                "reference": "low Far/source similarity",
            }[key] for key in warning_keys)
            verdict = f"{len(warning_keys)} items need improvement; prioritize structural vibration and Mic/SPK gain balance."
        else:
            findings = "no configured screening concern"
            verdict = "No obvious issue was found in the current structure or Mic/SPK gain balance."
        recommendations = _customer_recommendations(metrics, warning_keys, "en")
        lines = [
        "# Evaluation Test Report",
        "",
        "## Summary",
        f"- Result: {verdict}",
        f"- Findings: {findings}.",
        "",
        "## Recommendations",
        *[f"- {item}" for item in recommendations],
        "- Change one variable at a time in the order above and rerun the evaluation to verify the source of improvement.",
        "",
        "## Diagnostic Decision Map",
        "- The blue point is the current measurement, dashed lines are trigger thresholds, and light-red areas require review.",
        "- The panels cover nonlinearity/overdrive, acoustic-coupling stability, Mic gain/noise margin, and Far-reference/gain balance.",
        "- Review regions prioritize investigation; they do not prove a unique structural root cause.",
        "![Diagnostic decision map](diagnostic_map.png)",
        "",
        "## Scope",
        "- ESS-based, uncalibrated in-device acoustic screening at 16 kHz.",
        "- Capture roles: Mic ch0 and synchronous Far Reference ch1.",
        "- Results include the loudspeaker, enclosure, room, microphone and capture path.",
        "- This report is not an ISO 3382 certification or an absolute SPL measurement.",
        "",
        "## Alignment and Levels",
        f"- Mic relative to Far: {metrics['mic_to_far_latency_ms']:.3f} ms",
        f"- Correlation-aligned RIR direct arrival: {metrics['rir_direct_ms']:.3f} ms",
        f"- Mic/Far correlation confidence: {metrics['mic_correlation_confidence']:.3f} / {metrics['far_correlation_confidence']:.3f}",
        f"- Mic/Far RMS: {metrics['mic_rms_dbfs']:.2f} / {metrics['far_rms_dbfs']:.2f} dBFS",
        f"- Pre-sweep noise RMS: {_format_metric(metrics['noise_rms_dbfs'], ' dBFS', 2)}",
        "",
        "## Mic / Far Channel Health",
        f"- Mic ch0: peak {metrics['mic_health']['peak_dbfs']:.2f} dBFS, RMS {metrics['mic_health']['rms_dbfs']:.2f} dBFS, clipping {metrics['mic_health']['clip_ratio']:.6f}, DC {metrics['mic_health']['dc_offset_mean']:.6f}",
        f"- Far ch1: peak {metrics['far_health']['peak_dbfs']:.2f} dBFS, RMS {metrics['far_health']['rms_dbfs']:.2f} dBFS, clipping {metrics['far_health']['clip_ratio']:.6f}, DC {metrics['far_health']['dc_offset_mean']:.6f}",
        f"- Source: peak {metrics['source_health']['peak_dbfs']:.2f} dBFS, RMS {metrics['source_health']['rms_dbfs']:.2f} dBFS, clipping {metrics['source_health']['clip_ratio']:.6f}",
        f"- Mic/Far relative gain: {metrics['mic_to_far_gain_db']:.2f} dB",
        f"- Mic/Far source similarity: {metrics['mic_source_similarity']:.3f} / {metrics['far_source_similarity']:.3f}",
        "- Near-full-scale Far samples matching the source are reference content, not Mic clipping.",
        "",
        "## Acoustic Indicators",
        f"- Frequency-response P5-P95 span: {metrics['frequency_response_p5_p95_span_db']:.2f} dB",
        f"- RIR peak-to-tail-noise range: {metrics['decay_dynamic_range_db']:.2f} dB",
        f"- Pink-noise median coherence: {metrics['pink_noise_coherence_median']:.3f}",
        f"- Pink-noise Mic level/SNR margin: {metrics['pink_noise_mic_rms_dbfs']:.2f} dBFS / {_format_metric(metrics['pink_noise_snr_db'], ' dB', 2)}",
        f"- Mic/Far multitone signal-to-residual: {metrics['mic_multitone_signal_to_residual_db']:.2f} / {metrics['far_multitone_signal_to_residual_db']:.2f} dB",
        f"- EDT estimate: {_format_metric(metrics['edt_s'], ' s')}",
        f"- T20 extrapolated estimate: {_format_metric(metrics['t20_extrapolated_s'], ' s')}",
        "- EDT/T20 are omitted when decay range or linear-fit quality is insufficient.",
        "- Available values remain screening estimates and require calibrated geometry and level for standards use.",
        "",
        "## Capture Overview",
        "![Capture overview](capture_overview.png)",
        "",
        "## Mic / Far Spectrograms",
        "![Mic / Far spectrograms](capture_spectrogram.png)",
        "",
        "## Impulse Response and ETC",
        "![Impulse and ETC](impulse_etc.png)",
        "",
        "## Frequency Response",
        "![Frequency response](frequency_response.png)",
        "",
        "## Group Delay",
        "![Group delay](group_delay.png)",
        "",
        "## Time-Frequency Decay",
        "![Waterfall](waterfall.png)",
        ]
    with open(os.path.join(output_dir, "report.md"), "w", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description="RockAA Professional Acoustic Evaluation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate_parser = subparsers.add_parser("generate")
    generate_parser.add_argument("--out", required=True)
    generate_parser.add_argument("--sample-rate", type=int, default=16000)
    generate_parser.add_argument("--duration", type=float, default=5.0)
    generate_parser.add_argument("--start-hz", type=float, default=80.0)
    generate_parser.add_argument("--end-hz", type=float, default=7200.0)
    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("--source", required=True)
    analyze_parser.add_argument("--capture", required=True)
    analyze_parser.add_argument("--out", required=True)
    analyze_parser.add_argument("--duration", type=float, default=5.0)
    analyze_parser.add_argument("--start-hz", type=float, default=80.0)
    analyze_parser.add_argument("--end-hz", type=float, default=7200.0)
    analyze_parser.add_argument("--language", choices=("zh", "en"), default="en")
    args = parser.parse_args()

    if args.command == "generate":
        if args.sample_rate != 16000:
            raise ValueError("PAE v1 currently validates 16 kHz only")
        if not (20.0 <= args.start_hz < args.end_hz < args.sample_rate / 2.0):
            raise ValueError("invalid ESS frequency range")
        write_pcm16(args.out, args.sample_rate,
                    generate_ess(args.sample_rate, args.duration, args.start_hz, args.end_hz))
        print(args.out)
    else:
        analyze(args.source, args.capture, args.out, args.duration,
                args.start_hz, args.end_hz, args.language)
        print(args.out)


if __name__ == "__main__":
    main()
