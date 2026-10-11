"""OCR bounds and process isolation using synthetic PDFs and a mocked OS engine."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pymupdf

from app.services import pdf_ocr


class PDFOCRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qstudy-ocr-tests-")
        self.root = Path(self.temp.name)
        self.pdf = self.root / "document.pdf"
        self.staged = []
        self.fake_powershell = Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")

    def tearDown(self):
        self.temp.cleanup()

    def document(self, kinds, *, huge=False):
        with pymupdf.open() as document:
            for kind in kinds:
                page = document.new_page(width=1800 if huge else 400, height=3100 if huge else 600)
                if kind == "native":
                    page.insert_text((30, 40), "Native course text with more than thirty printable characters.", fontsize=8)
                elif kind == "short":
                    page.insert_text((30, 40), "Short note", fontsize=8)
                elif kind == "scan":
                    image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 16, 16), False)
                    image.clear_with(255)
                    page.insert_image(page.rect, stream=image.tobytes("png"))
                elif kind == "drawing":
                    page.draw_rect(pymupdf.Rect(30, 30, 100, 100))
            document.save(self.pdf)

    def process(self, *, lines=None, transform=None, fail=None):
        def run(arguments, **kwargs):
            self.assertEqual(arguments[0], str(self.fake_powershell))
            self.assertFalse(kwargs["shell"])
            self.assertTrue(kwargs["capture_output"])
            self.assertEqual(kwargs["encoding"], "utf-8")
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], pdf_ocr.MAX_SECONDS)
            self.assertEqual(kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
            manifest = Path(arguments[arguments.index("-ManifestPath") + 1])
            self.staged.append(manifest.parent)
            request = json.loads(manifest.read_text(encoding="utf-8"))
            for page in request["pages"]:
                image = Path(page["path"])
                self.assertEqual(image.parent, manifest.parent)
                self.assertTrue(image.is_file())
                rendered = pymupdf.Pixmap(str(image))
                self.assertLessEqual(max(rendered.width, rendered.height), pdf_ocr.MAX_IMAGE_DIMENSION)
            if fail:
                raise fail
            result = {"ok": True, "language": "ru", "pages": [
                {"index": page["index"], "lines": lines if lines is not None else ["Неделя 1", "Модуль: русский язык"]}
                for page in request["pages"]]}
            result = transform(result) if transform else result
            return subprocess.CompletedProcess(arguments, 0, json.dumps(result, ensure_ascii=False), "")
        return run

    def recognize(self, **kwargs):
        with patch.object(pdf_ocr, "_windows_powershell", return_value=self.fake_powershell):
            return pdf_ocr.recognize_pdf(self.pdf, **kwargs)

    def assert_staging_removed(self):
        self.assertTrue(self.staged)
        for directory in self.staged:
            self.assertFalse(directory.exists())

    def test_native_and_short_native_text_need_no_ocr(self):
        self.document(["native", "short"])
        with patch.object(pdf_ocr.subprocess, "run") as process:
            text, warnings = self.recognize()
        self.assertIn("Native course text", text)
        self.assertIn("Short note", text)
        self.assertIn("### Страница 2", text)
        self.assertEqual(warnings, [])
        process.assert_not_called()

    def test_blank_pdf_does_not_fabricate_text_or_page_markers(self):
        self.document(["blank", "blank"])
        with patch.object(pdf_ocr.subprocess, "run") as process:
            self.assertEqual(self.recognize(), ("", []))
        process.assert_not_called()

    def test_mixed_pdf_keeps_native_pages_and_per_line_ocr(self):
        self.document(["native", "scan", "blank"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process()) as process:
            text, warnings = self.recognize()
        self.assertIn("Native course text", text)
        self.assertIn("### Страница 2 (OCR)\nНеделя 1\nМодуль: русский язык", text)
        self.assertNotIn("### Страница 3", text)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(process.call_count, 1)
        self.assert_staging_removed()

    def test_vector_scan_and_large_page_render_are_bounded(self):
        self.document(["scan", "drawing"], huge=True)
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process()):
            text, _ = self.recognize()
        self.assertEqual(text.count("(OCR)"), 2)
        self.assert_staging_removed()

    def test_faint_gray_ink_is_darkened_without_inverting_paper_or_black_text(self):
        image = pymupdf.Pixmap(pymupdf.csGRAY, 3, 1, bytes([0, 200, 255]), False)
        enhanced = pdf_ocr._enhance_scan(image)
        self.assertEqual(enhanced.samples[0], 0)
        self.assertEqual(enhanced.samples[2], 255)
        self.assertLess(enhanced.samples[1], image.samples[1])
        self.assertGreater(enhanced.samples[1], 0)
        self.assertEqual((enhanced.width, enhanced.height), (image.width, image.height))

    def test_selected_pages_are_zero_based_unique_and_document_order(self):
        self.document(["scan", "scan", "scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process()):
            text, _ = self.recognize(page_indices=[2, 0, 2])
        self.assertEqual(text.count("### Страница"), 2)
        self.assertLess(text.index("Страница 1"), text.index("Страница 3"))
        self.assertNotIn("Страница 2", text)
        self.assert_staging_removed()

    def test_scanned_page_limit_rejects_without_partial_result(self):
        self.assertEqual(pdf_ocr.MAX_OCR_PAGES, 50)
        self.document(["scan"] * 3)
        with patch.object(pdf_ocr, "MAX_OCR_PAGES", 2), patch.object(pdf_ocr.subprocess, "run") as process:
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "50 страниц"):
                self.recognize()
        process.assert_not_called()

    def test_empty_ocr_result_keeps_blank_scan_empty(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(lines=[])):
            text, warnings = self.recognize()
        self.assertEqual(text, "")
        self.assertTrue(any("не обнаружило" in warning for warning in warnings))
        self.assert_staging_removed()

    def test_timeout_is_safe_and_removes_staged_images(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(fail=subprocess.TimeoutExpired("private-path", 1, output="private contents"))):
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком долго") as error:
                self.recognize()
        self.assertNotIn("private", str(error.exception))
        self.assert_staging_removed()

    def test_missing_russian_language_and_nonzero_exit_never_expose_stderr(self):
        self.document(["scan"])
        for code, phrase in [("missing_russian_language", "русский"), ("recognition_failed", "не смогло"), ("timeout", "слишком долго"), ("text_limit", "слишком много")]:
            with self.subTest(code=code):
                def failure(arguments, **kwargs):
                    manifest = Path(arguments[-1])
                    self.staged.append(manifest.parent)
                    return subprocess.CompletedProcess(arguments, 1, json.dumps({"ok": False, "error": code}), "private document secret")
                with patch.object(pdf_ocr.subprocess, "run", side_effect=failure):
                    with self.assertRaisesRegex(pdf_ocr.PDFOCRError, phrase) as error:
                        self.recognize()
                self.assertNotIn("secret", str(error.exception))
        self.assert_staging_removed()

    def test_malformed_duplicate_missing_and_wrong_language_results_are_rejected(self):
        self.document(["scan", "scan"])
        transformations = [
            lambda result: [],
            lambda result: {**result, "language": "en-US"},
            lambda result: {**result, "pages": result["pages"][:1]},
            lambda result: {**result, "pages": [result["pages"][0], result["pages"][0]]},
            lambda result: {**result, "pages": [{"index": 999, "lines": []}]},
            lambda result: {**result, "pages": [{"index": 0, "lines": [123]}]},
        ]
        for transform in transformations:
            with self.subTest(transform=transform):
                with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(transform=transform)):
                    with self.assertRaises(pdf_ocr.PDFOCRError):
                        self.recognize()
        with patch.object(pdf_ocr.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "not-json private secret", "private secret")):
            with self.assertRaises(pdf_ocr.PDFOCRError) as error:
                self.recognize()
        self.assertNotIn("private", str(error.exception))
        self.assert_staging_removed()

    def test_aggregate_text_limit_includes_native_ocr_and_page_markers(self):
        self.document(["native", "scan"])
        with patch.object(pdf_ocr, "MAX_CHARS", 200), patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(lines=["а" * 150])):
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком много"):
                self.recognize()
        self.assert_staging_removed()

    def test_global_time_budget_and_invalid_page_selection(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.time, "monotonic", side_effect=[0, pdf_ocr.MAX_SECONDS + 1]), patch.object(pdf_ocr.subprocess, "run") as process:
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком долго"):
                self.recognize()
        process.assert_not_called()
        for pages in ([-1], [1], [True], ["0"], 1):
            with self.subTest(pages=pages), self.assertRaises(pdf_ocr.PDFOCRError):
                self.recognize(page_indices=pages)

    def test_password_protected_pdf_returns_a_friendly_error(self):
        with pymupdf.open() as document:
            document.new_page()
            document.save(self.pdf, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="private-user-password", owner_pw="private-owner-password")
        with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "защищён паролем"):
            self.recognize()


if __name__ == "__main__":
    unittest.main()
