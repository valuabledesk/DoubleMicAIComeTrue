import json
import os
import tempfile
import unittest

import numpy as np
from scipy import signal

try:
    from .pae_cli import (_annotate_diagnostic_point, _customer_recommendations,
                          analyze, generate_ess, write_pcm16)
except ImportError:
    from pae_cli import (_annotate_diagnostic_point, _customer_recommendations,
                         analyze, generate_ess, write_pcm16)


class ProfessionalAcousticEvaluationTest(unittest.TestCase):
    def test_diagnostic_annotation_stays_close_and_points_inward(self):
        import matplotlib.pyplot as plt

        figure, axis = plt.subplots()
        axis.set_xlim(0.0, 1.0)
        axis.set_ylim(0.0, 1.0)
        lower_left = _annotate_diagnostic_point(axis, 0.02, 0.02, "lower-left")
        upper_right = _annotate_diagnostic_point(axis, 0.98, 0.98, "upper-right")
        self.assertEqual(lower_left.get_ha(), "left")
        self.assertEqual(lower_left.get_va(), "bottom")
        self.assertEqual(upper_right.get_ha(), "right")
        self.assertEqual(upper_right.get_va(), "top")
        for annotation in (lower_left, upper_right):
            self.assertLessEqual(abs(annotation.xyann[0]), 6)
            self.assertLessEqual(abs(annotation.xyann[1]), 6)
        plt.close(figure)

    def test_customer_recommendations_follow_measured_level(self):
        low_level = {"mic_health": {"peak_dbfs": -20.0}, "pink_noise_mic_rms_dbfs": -42.0}
        self.assertIn("提高 Mic 增益", _customer_recommendations(low_level, ["snr"], "zh")[0])

        clipped = {"mic_health": {"peak_dbfs": -0.5}, "pink_noise_mic_rms_dbfs": -12.0}
        advice = _customer_recommendations(clipped, ["clipping", "snr", "multitone"], "zh")
        self.assertIn("降低 Mic", advice[0])
        self.assertFalse(any("提高 Mic" in item for item in advice))
        self.assertTrue(any("缓冲材料" in item for item in advice))

    def test_recovers_synthetic_acoustic_delay(self):
        sample_rate = 16000
        source = generate_ess(sample_rate, 2.0, 100.0, 7000.0, 0.5, 0.5)
        reference = source[:, 0]
        startup = 4000
        acoustic_delay = 144
        far = np.concatenate([np.zeros(startup), reference, np.zeros(2000)])
        impulse = np.zeros(acoustic_delay + 4)
        impulse[acoustic_delay] = 0.4
        mic_signal = signal.fftconvolve(reference, impulse)[:len(reference)]
        mic = np.concatenate([np.zeros(startup), mic_signal, np.zeros(2000)])
        capture = np.column_stack([mic, far])

        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "source.wav")
            capture_path = os.path.join(directory, "capture.wav")
            report_dir = os.path.join(directory, "report")
            write_pcm16(source_path, sample_rate, source)
            write_pcm16(capture_path, sample_rate, capture)
            metrics = analyze(source_path, capture_path, report_dir, 2.0, 100.0, 7000.0)

            self.assertAlmostEqual(metrics["mic_to_far_latency_ms"], 9.0, delta=0.2)
            self.assertAlmostEqual(metrics["rir_direct_ms"], 9.0, delta=0.2)
            self.assertGreater(metrics["pink_noise_coherence_median"], 0.9)
            self.assertIn("mic_multitone_signal_to_residual_db", metrics)
            self.assertGreater(metrics["far_source_similarity"], 0.99)
            self.assertAlmostEqual(metrics["mic_to_far_gain_db"], -7.96, delta=0.2)
            self.assertEqual(metrics["mic_health"]["clip_ratio"], 0.0)
            self.assertIn("diagnostic_flags", metrics)
            for name in ["metrics.json", "report.md", "capture_overview.png",
                         "capture_spectrogram.png",
                         "diagnostic_map.png",
                         "impulse_etc.png", "frequency_response.png",
                         "group_delay.png", "waterfall.png"]:
                self.assertTrue(os.path.isfile(os.path.join(report_dir, name)), name)
            with open(os.path.join(report_dir, "report.md"), encoding="utf-8") as stream:
                report = stream.read()
            with open(os.path.join(report_dir, "metrics.json"), encoding="utf-8") as stream:
                self.assertIn("diagnostic_flags", json.load(stream))
            self.assertIn("# Evaluation Test Report", report)
            self.assertIn("## Recommendations", report)
            self.assertIn("## Diagnostic Decision Map", report)
            self.assertIn("Change one variable at a time", report)

            chinese_report = os.path.join(directory, "report_zh")
            analyze(source_path, capture_path, chinese_report, 2.0, 100.0, 7000.0, "zh")
            with open(os.path.join(chinese_report, "report.md"), encoding="utf-8") as stream:
                report = stream.read()
            self.assertIn("# 评估测试报告", report)
            self.assertIn("## 总结", report)
            self.assertIn("## 优化建议", report)
            self.assertIn("## 判定依据图", report)
            self.assertIn("每次只改变一个变量", report)
            self.assertIn("粉红噪声", report)
            self.assertIn("多音", report)


if __name__ == "__main__":
    unittest.main()
