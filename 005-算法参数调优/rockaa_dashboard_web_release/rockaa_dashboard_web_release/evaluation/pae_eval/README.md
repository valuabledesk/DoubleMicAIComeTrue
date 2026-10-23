# Professional Acoustic Evaluation

`pae_eval` is the Dashboard host-side Professional Acoustic Evaluation (PAE)
module. PAE v1 performs an uncalibrated 16 kHz acoustic screening measurement:

PAE is the single Dashboard acoustic-evaluation implementation. The former
`audio_eval` workflow was retired after its channel-health, relative-gain,
source-similarity, waveform, and spectrogram checks were integrated here.

1. Generate a deterministic two-channel test sequence containing an
   exponential sine sweep (ESS), pink noise, and a seven-tone signal.
2. Play it on the selected board while `rockaa_capt -c 2 -C 1` records
   Mic ch0 and synchronous Far Reference ch1.
3. Align both channels with the generated source.
4. Convolve the Mic response with the exponential-weighted inverse ESS to
   estimate the acoustic impulse response and transfer response.
5. Use pink noise for broadband coherence and the multitone segment for a
   signal-to-residual screening measurement.
6. Produce a localized summary, alignment/level metrics, an estimated RIR and
   ETC, relative response, group delay, and a time-frequency decay plot.

This measurement includes the loudspeaker, enclosure, room, microphone and
capture path. It is not an absolute SPL measurement or an ISO 3382
certification. Standards-oriented use additionally requires calibrated
hardware, controlled geometry, sufficient decay range and repeated positions.

## CLI

```bash
python3 pae_cli.py generate \
  --out /tmp/pae_ess.wav --sample-rate 16000 \
  --duration 5 --start-hz 80 --end-hz 7200

python3 pae_cli.py analyze \
  --source /tmp/pae_ess.wav \
  --capture /tmp/pae_capture.wav \
  --out /tmp/pae_report --language zh
```

## Test

```bash
python3 -m unittest -v test_pae.py
```

The synthetic test convolves the ESS with a known delayed impulse response and
checks recovered Mic/Far latency, the correlation-aligned RIR direct arrival,
metrics output and all report plots.
