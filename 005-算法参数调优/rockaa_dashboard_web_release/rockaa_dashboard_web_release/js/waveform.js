// ── waveform renderer ──
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds) {
  if (seconds < 0.001) return (seconds * 1000000).toFixed(0) + ' us';
  if (seconds < 1) return (seconds * 1000).toFixed(2) + ' ms';
  return seconds.toFixed(2) + ' s';
}

function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

function colorMix(from, to, ratio) {
  const t = clamp(ratio, 0, 1);
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function rgb(color) {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

class WaveformRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.samples = [];
    this.channels = 1;
    this.sampleRate = 16000;
    this.timeZoom = 1.0;
    this.timeOffset = 0;
    this.vertZoom = 1.0;
    this.vertOffset = 0;
    this.color = '#36c57e';
    this.outputPreview = false;
    this.channelIndex = 0;
    this.followTail = true;
    this.displayMode = 'time';
    // SED event spans in seconds, [{t0, t1}], drawn on the shared time axis
    this.eventSpans = [];
    this.eventColor = 'rgba(255,95,86,.8)';
    this.onViewChange = null;
    this.dragging = false;
    this.dragStartX = 0;
    this.dragStartOffset = 0;
    this.vertDragging = false;
    this.vertDragStartY = 0;
    this.vertDragStartOffset = 0;
    this.resize();
    this.bindInteraction();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement);
  }

  plotRect() {
    return {
      left: 52,
      top: 24,
      right: Math.max(56, (this.w || 0) - 10),
      bottom: Math.max(28, (this.h || 0) - 22),
    };
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.paint();
  }

  bindInteraction() {
    this.canvas.addEventListener('wheel', ev => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.5 : 1 / 1.5;
      const plot = this.plotRect();
      if (ev.offsetX < plot.left && ev.offsetY >= plot.top && ev.offsetY <= plot.bottom) {
        this.vertZoom = clamp(this.vertZoom * factor, 1, 64);
        if (this.vertZoom <= 1) this.vertOffset = 0;
        this.paint();
        this.emitViewChange();
        return;
      }
      this.zoomAt(ev.offsetX, factor);
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', ev => {
      const plot = this.plotRect();
      if (ev.offsetX < plot.left && ev.offsetY >= plot.top && ev.offsetY <= plot.bottom
          && this.vertZoom > 1) {
        this.vertDragging = true;
        this.vertDragStartY = ev.clientY;
        this.vertDragStartOffset = this.vertOffset;
        this.canvas.classList.add('dragging');
        this.canvas.setPointerCapture(ev.pointerId);
        return;
      }
      if (ev.offsetX < plot.left || ev.offsetX > plot.right || ev.offsetY < plot.top || ev.offsetY > plot.bottom)
        return;
      this.dragging = true;
      this.dragStartX = ev.clientX;
      this.dragStartOffset = this.currentStartFrame();
      this.canvas.classList.add('dragging');
      this.canvas.setPointerCapture(ev.pointerId);
    });
    this.canvas.addEventListener('pointermove', ev => {
      if (this.vertDragging) {
        const dy = ev.clientY - this.vertDragStartY;
        const plot = this.plotRect();
        const range = 2 / this.vertZoom;
        const pixRange = Math.max(1, plot.bottom - plot.top);
        this.vertOffset = clamp(this.vertDragStartOffset - dy / pixRange * range,
          -2, 2);
        this.paint();
        this.emitViewChange();
        return;
      }
      if (!this.dragging) return;
      const dx = ev.clientX - this.dragStartX;
      const visFrames = this.visibleFrames();
      const plot = this.plotRect();
      const nextOffset = this.dragStartOffset - dx / Math.max(1, plot.right - plot.left) * visFrames;
      this.setStartFrame(nextOffset);
    });
    const stopDrag = ev => {
      if (this.vertDragging) {
        this.vertDragging = false;
        this.canvas.classList.remove('dragging');
        try { this.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
        return;
      }
      if (!this.dragging) return;
      this.dragging = false;
      this.canvas.classList.remove('dragging');
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
    this.canvas.addEventListener('dblclick', () => {
      this.followTail = true;
      this.timeZoom = 1.0;
      this.timeOffset = 0;
      this.vertOffset = 0;
      this.paint();
      this.emitViewChange();
    });
  }

  totalFrames() {
    return Math.floor(this.samples.length / Math.max(1, this.channels));
  }

  visibleFrames() {
    const total = this.totalFrames();
    if (!total) return 0;
    return clamp(Math.floor(total / Math.max(1, this.timeZoom)), 2, total);
  }

  currentStartFrame() {
    const total = this.totalFrames();
    const visFrames = this.visibleFrames();
    if (!total) return 0;
    const maxStart = Math.max(0, total - visFrames);
    return this.followTail ? maxStart : clamp(Math.floor(this.timeOffset), 0, maxStart);
  }

  setStartFrame(frame) {
    const total = this.totalFrames();
    const visFrames = this.visibleFrames();
    const maxStart = Math.max(0, total - visFrames);
    this.followTail = false;
    this.timeOffset = clamp(Math.floor(frame), 0, maxStart);
    this.paint();
    this.emitViewChange();
  }

  zoomAt(x, factor) {
    const total = this.totalFrames();
    if (total < 2 || !this.w) return;
    const oldVis = this.visibleFrames();
    const oldStart = this.currentStartFrame();
    const plot = this.plotRect();
    const ratio = clamp((x - plot.left) / Math.max(1, plot.right - plot.left), 0, 1);
    const anchorFrame = oldStart + oldVis * ratio;
    this.timeZoom = clamp(this.timeZoom * factor, 1, Math.max(1, total / 16));
    const newVis = this.visibleFrames();
    this.followTail = false;
    this.timeOffset = clamp(Math.floor(anchorFrame - newVis * ratio), 0, Math.max(0, total - newVis));
    this.paint();
    this.emitViewChange();
  }

  copyViewFrom(other) {
    this.timeZoom = other.timeZoom;
    this.followTail = other.followTail;
    this.timeOffset = other.currentStartFrame();
    this.vertZoom = other.vertZoom;
    this.vertOffset = other.vertOffset;
    this.paint();
  }

  sampleAt(frame, channel = 0) {
    const ch = Math.max(1, this.channels);
    const total = this.totalFrames();
    if (frame < 0 || frame >= total) return 0;
    return this.samples[frame * ch + Math.floor(clamp(channel, 0, ch - 1))] || 0;
  }

  drawBase(ctx, w, h) {
    ctx.fillStyle = '#181f26';
    ctx.fillRect(0, 0, w, h);
    return this.plotRect();
  }

  drawTimeGrid(ctx, plot) {
    ctx.strokeStyle = '#39444f';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = plot.top + (plot.bottom - plot.top) * i / 4;
      ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
    }
    for (let i = 0; i <= 10; i++) {
      const x = plot.left + (plot.right - plot.left) * i / 10;
      ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, plot.bottom); ctx.stroke();
    }

    ctx.fillStyle = '#8ea0b0';
    ctx.font = '10px Consolas,monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = plot.top + (plot.bottom - plot.top) * i / 4;
      const value = (1.0 - 0.5 * i) / this.vertZoom + this.vertOffset;
      ctx.fillText(value === 0 ? '0.0' : value.toFixed(2), plot.left - 6, y);
    }

    const startFrame = this.currentStartFrame();
    const visFrames = this.visibleFrames();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i++) {
      const x = plot.left + (plot.right - plot.left) * i / 5;
      const seconds = (startFrame + visFrames * i / 5) / Math.max(1, this.sampleRate);
      ctx.fillText(formatTime(seconds), x, plot.bottom + 4);
    }
    ctx.textAlign = 'left';
  }

  drawFrequencyGrid(ctx, plot) {
    ctx.strokeStyle = '#39444f';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 8; i++) {
      const y = plot.top + (plot.bottom - plot.top) * i / 8;
      ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
    }
    for (let i = 0; i <= 10; i++) {
      const x = plot.left + (plot.right - plot.left) * i / 10;
      ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, plot.bottom); ctx.stroke();
    }

    ctx.fillStyle = '#8ea0b0';
    ctx.font = '10px Consolas,monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const visibleNyquistKhz = this.sampleRate / 2000 / this.vertZoom;
    const freqOffsetKhz = this.vertOffset * (this.sampleRate / 2000);
    for (let i = 0; i <= 4; i++) {
      const y = plot.bottom - (plot.bottom - plot.top) * i / 4;
      ctx.fillText((freqOffsetKhz + visibleNyquistKhz * i / 4).toFixed(1) + 'k', plot.left - 6, y);
    }

    const startFrame = this.currentStartFrame();
    const visFrames = this.visibleFrames();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i++) {
      const x = plot.left + (plot.right - plot.left) * i / 5;
      const seconds = (startFrame + visFrames * i / 5) / Math.max(1, this.sampleRate);
      ctx.fillText(formatTime(seconds), x, plot.bottom + 4);
    }
    ctx.textAlign = 'left';
  }

  spectrogramColor(value) {
    const v = Math.pow(clamp(value, 0, 1), 0.78);
    if (v < 0.06) return 'rgb(0,0,4)';
    if (v < 0.22) return rgb(colorMix([0, 0, 6], [18, 0, 58], (v - 0.06) / 0.16));
    if (v < 0.42) return rgb(colorMix([18, 0, 58], [76, 0, 116], (v - 0.22) / 0.20));
    if (v < 0.62) return rgb(colorMix([76, 0, 116], [222, 0, 92], (v - 0.42) / 0.20));
    if (v < 0.80) return rgb(colorMix([222, 0, 92], [255, 104, 0], (v - 0.62) / 0.18));
    if (v < 0.92) return rgb(colorMix([255, 104, 0], [255, 228, 76], (v - 0.80) / 0.12));
    return rgb(colorMix([255, 228, 76], [255, 255, 255], (v - 0.92) / 0.08));
  }

  fft(real, imag) {
    const size = real.length;
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const angle = -2 * Math.PI / length;
      const wlenReal = Math.cos(angle);
      const wlenImag = Math.sin(angle);
      for (let i = 0; i < size; i += length) {
        let wReal = 1;
        let wImag = 0;
        for (let j = 0; j < length / 2; j++) {
          const even = i + j;
          const odd = even + length / 2;
          const oddReal = real[odd] * wReal - imag[odd] * wImag;
          const oddImag = real[odd] * wImag + imag[odd] * wReal;
          const evenReal = real[even];
          const evenImag = imag[even];
          real[even] = evenReal + oddReal;
          imag[even] = evenImag + oddImag;
          real[odd] = evenReal - oddReal;
          imag[odd] = evenImag - oddImag;
          const nextReal = wReal * wlenReal - wImag * wlenImag;
          wImag = wReal * wlenImag + wImag * wlenReal;
          wReal = nextReal;
        }
      }
    }
  }

  fftMagnitudesAt(centerFrame, fftSize) {
    const half = fftSize >> 1;
    const real = new Array(fftSize).fill(0);
    const imag = new Array(fftSize).fill(0);
    const total = this.totalFrames();
    let windowSum = 0;
    for (let n = 0; n < fftSize; n++) {
      const frame = clamp(centerFrame - half + n, 0, Math.max(0, total - 1));
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / Math.max(1, fftSize - 1));
      real[n] = this.sampleAt(frame, this.channelIndex) * win;
      windowSum += win;
    }
    this.fft(real, imag);
    const normalize = Math.max(1, windowSum * 0.5);
    const mags = new Array(half + 1);
    for (let bin = 0; bin <= half; bin++)
      mags[bin] = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]) / normalize;
    return mags;
  }

  emitViewChange() {
    if (typeof this.onViewChange === 'function') this.onViewChange(this);
  }

  // Draws SED event spans on the plot: a bright tick inside the top edge of
  // the plot plus a faint vertical band below it, sharing the waveform time
  // axis so events can be compared against the audio content. Spans carry
  // absolute audio timestamps; on rolling (online) views eventOriginSec is
  // the absolute time at the window start and shifts them accordingly.
  drawEventSpans(ctx, plot, startFrame, visFrames) {
    if (!Array.isArray(this.eventSpans) || !this.eventSpans.length) return;
    if (!this.sampleRate || visFrames <= 0) return;
    const plotW = Math.max(1, plot.right - plot.left);
    const bandH = Math.max(8, (plot.bottom - plot.top) * 0.28);
    const originSec = Number.isFinite(this.eventOriginSec) ? this.eventOriginSec : 0;
    for (const span of this.eventSpans) {
      if (span == null || !Number.isFinite(span.t0) || !Number.isFinite(span.t1)) continue;
      const x0 = plot.left + ((span.t0 - originSec) * this.sampleRate - startFrame) / visFrames * plotW;
      const x1 = plot.left + ((span.t1 - originSec) * this.sampleRate - startFrame) / visFrames * plotW;
      const cx0 = clamp(x0, plot.left, plot.right);
      const cx1 = clamp(x1, plot.left, plot.right);
      if (cx1 <= plot.left || cx0 >= plot.right) continue;
      const w = Math.max(2, cx1 - cx0);
      ctx.fillStyle = 'rgba(255,95,86,.14)';
      ctx.fillRect(cx0, plot.top + 5, w, bandH);
      ctx.fillStyle = this.eventColor;
      ctx.fillRect(cx0, plot.top, w, 5);
    }
  }

  paint() {
    const { ctx, w, h, samples, channels } = this;
    if (!w || !h) return;
    const plot = this.drawBase(ctx, w, h);

    if (samples.length < channels) {
      if (this.displayMode === 'spectrogram' || this.displayMode === 'freq')
        this.drawFrequencyGrid(ctx, plot);
      else
        this.drawTimeGrid(ctx, plot);
      return;
    }

    // calculate visible range
    const totalFrames = this.totalFrames();
    const visFrames = this.visibleFrames();
    const startFrame = this.currentStartFrame();

    if (this.displayMode === 'spectrogram' || this.displayMode === 'freq') {
      this.paintFrequency(ctx, plot, totalFrames, visFrames, startFrame);
      return;
    }

    this.drawTimeGrid(ctx, plot);
    this.drawEventSpans(ctx, plot, startFrame, visFrames);

    const ch0 = [];
    for (let i = 0; i < visFrames; i++) {
      const idx = (startFrame + i) * channels;
      const channel = Math.floor(clamp(this.channelIndex, 0, channels - 1));
      if (idx + channel < samples.length) ch0.push(samples[idx + channel]);
    }

    if (ch0.length < 2) return;

    const midY = (plot.top + plot.bottom) / 2;
    const ampScale = (plot.bottom - plot.top) * 0.5 * this.vertZoom;

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();

    const plotW = Math.max(1, plot.right - plot.left);
    const step = Math.max(1, Math.floor(ch0.length / plotW));
    if (ch0.length <= plotW * 4) {
      // line mode
      for (let i = 0; i < ch0.length; i++) {
        const x = plot.left + (i / Math.max(1, ch0.length - 1)) * plotW;
        const y = clamp(midY - (ch0[i] - this.vertOffset) * ampScale, plot.top, plot.bottom);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    } else {
      // envelope mode
      for (let px = 0; px < plotW; px++) {
        const from = Math.floor(px * ch0.length / plotW);
        const to = Math.min(from + step, ch0.length);
        let mn = 1, mx = -1;
        for (let j = from; j < to; j++) { mn = Math.min(mn, ch0[j]); mx = Math.max(mx, ch0[j]); }
        const x = plot.left + px + 0.5;
        ctx.moveTo(x, clamp(midY - (mx - this.vertOffset) * ampScale, plot.top, plot.bottom));
        ctx.lineTo(x, clamp(midY - (mn - this.vertOffset) * ampScale, plot.top, plot.bottom));
      }
    }
    ctx.stroke();

    ctx.strokeStyle = '#6c7c89';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.left, clamp(midY + this.vertOffset * ampScale, plot.top, plot.bottom));
    ctx.lineTo(plot.right, clamp(midY + this.vertOffset * ampScale, plot.top, plot.bottom));
    ctx.stroke();
  }

  paintFrequency(ctx, plot, totalFrames, visFrames, startFrame) {
    if (totalFrames <= 0) {
      this.drawFrequencyGrid(ctx, plot);
      return;
    }
    const plotW = Math.max(1, plot.right - plot.left);
    const plotH = Math.max(1, plot.bottom - plot.top);
    const timeBins = clamp(Math.floor(plotW), 1, 240);
    const freqBins = clamp(Math.floor(plotH / 2), 48, 96);
    const framesPerPixel = Math.max(1, Math.ceil(visFrames / timeBins));
    const fftSize = clamp(nextPowerOfTwo(clamp(framesPerPixel * 4, 128, 2048)), 128, 2048);
    const maxBin = fftSize / 2;
    const cellW = plotW / timeBins;
    const cellH = plotH / freqBins;
    const outputGain = this.outputPreview ? 0.72 : 1.0;

    for (let x = 0; x < timeBins; x++) {
      const centerFrame = clamp(
        startFrame + Math.floor((x + 0.5) * visFrames / timeBins),
        0,
        Math.max(0, totalFrames - 1)
      );
      const mags = this.fftMagnitudesAt(centerFrame, fftSize);
      for (let y = 0; y < freqBins; y++) {
        const normalizedFreq = y / Math.max(1, freqBins - 1);
        const nextFreq = (y + 1) / Math.max(1, freqBins - 1);
        const offsetBins = Math.floor(this.vertOffset * maxBin);
        const visibleBins = maxBin / this.vertZoom;
        const firstBin = clamp(offsetBins + Math.floor(normalizedFreq * visibleBins), 0, maxBin);
        const lastBin = clamp(offsetBins + Math.ceil(nextFreq * visibleBins), firstBin, maxBin);
        let magnitude = 0;
        for (let bin = firstBin; bin <= lastBin; bin++)
          magnitude = Math.max(magnitude, mags[bin] || 0);
        magnitude *= outputGain;
        const db = 20 * Math.log10(Math.max(1e-7, magnitude));
        const value = clamp((db + 82) / 62, 0, 1);
        ctx.fillStyle = this.spectrogramColor(value);
        ctx.fillRect(plot.left + x * cellW, plot.bottom - (y + 1) * cellH, cellW + 0.8, cellH + 0.8);
      }
    }
    this.drawEventSpans(ctx, plot, startFrame, visFrames);
    this.drawFrequencyGrid(ctx, plot);
  }
}
