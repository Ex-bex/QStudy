"""Linux OCR process, language, budget and cleanup contracts without Tesseract."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pymupdf

from app.services import pdf_ocr


class LinuxPDFOCRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qstudy-linux-ocr-tests-")
        self.root = Path(self.temp.name)
        self.pdf = self.root / "document.pdf"
        self.executable = self.root / "trusted tesseract"
        self.executable.write_bytes(b"fixture executable")
        self.executable.chmod(0o700)
        self.staged = []
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def document(self, kinds):
        with pymupdf.open() as document:
            for kind in kinds:
                page = document.new_page(width=400, height=600)
                if kind == "native":
                    page.insert_text((30, 40), "Native course text with more than thirty printable characters.", fontsize=8)
                elif kind == "scan":
                    image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 16, 16), False)
                    image.clear_with(255)
                    page.insert_image(page.rect, stream=image.tobytes("png"))
            document.save(self.pdf)

    def process(self, *, languages=b"List of available languages in private-server-path (3):\neng\nrus\nkaz\n",
                text=None, fail_listing=None, fail_page=None, corrupt=False, remove_output=False):
        def run(arguments, **kwargs):
            self.calls.append(arguments)
            self.assertEqual(arguments[0], str(self.executable))
            self.assertIs(kwargs["shell"], False)
            self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            self.assertIs(kwargs["check"], False)
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], pdf_ocr.MAX_SECONDS)
            if arguments[1:] == ["--list-langs"]:
                if isinstance(fail_listing, Exception):
                    raise fail_listing
                kwargs["stdout"].write(languages)
                kwargs["stdout"].flush()
                return subprocess.CompletedProcess(arguments, fail_listing or 0, None, None)
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(arguments[3], "-l")
            self.assertEqual(arguments[5:], ["--psm", "3", "-c", "preserve_interword_spaces=1"])
            image = Path(arguments[1])
            output = Path(arguments[2]).with_suffix(".txt")
            self.assertEqual(image.parent, output.parent)
            self.assertTrue(image.is_file())
            self.assertTrue(output.is_file())
            rendered = pymupdf.Pixmap(str(image))
            self.assertEqual(rendered.n, 1)
            self.assertLessEqual(max(rendered.width, rendered.height), pdf_ocr.MAX_IMAGE_DIMENSION)
            if os.name != "nt":
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
            if isinstance(fail_page, Exception):
                raise fail_page
            if remove_output:
                output.unlink()
            elif corrupt:
                output.write_bytes(b"\xffprivate document text")
            else:
                number = int(image.stem.removeprefix("page-"))
                content = text if text is not None else f"\ufeffНеделя {number}\n\nМодуль: русский язык\x00\n\f"
                output.write_text(content, encoding="utf-8")
            return subprocess.CompletedProcess(arguments, fail_page or 0, None, None)
        return run

    def recognize(self, **kwargs):
        real_temporary_directory = tempfile.TemporaryDirectory
        def stage(*arguments, **options):
            directory = real_temporary_directory(*arguments, **options)
            self.staged.append(Path(directory.name))
            return directory
        with patch.object(pdf_ocr.sys, "platform", "linux"), \
                patch.object(pdf_ocr, "_linux_tesseract", return_value=self.executable), \
                patch.object(pdf_ocr.tempfile, "TemporaryDirectory", side_effect=stage):
            return pdf_ocr.recognize_pdf(self.pdf, **kwargs)

    def assert_staging_removed(self):
        self.assertTrue(self.staged)
        self.assertTrue(all(not directory.exists() for directory in self.staged))

    def test_native_and_blank_pages_do_not_invoke_tesseract(self):
        self.document(["native", "blank"])
        with patch.object(pdf_ocr.subprocess, "run") as process:
            text, warnings = self.recognize()
        self.assertIn("Native course text", text)
        self.assertNotIn("Страница 2", text)
        self.assertEqual(warnings, [])
        process.assert_not_called()
        self.assert_staging_removed()

    def test_mixed_pdf_retains_native_text_and_reports_actual_engine(self):
        self.document(["scan", "native", "scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process()):
            text, warnings = self.recognize(page_indices=[2, 0, 1, 2])
        self.assertIn("### Страница 1 (OCR)\nНеделя 1\nМодуль: русский язык", text)
        self.assertIn("Native course text", text)
        self.assertIn("### Страница 3 (OCR)\nНеделя 3", text)
        self.assertLess(text.index("Страница 1"), text.index("Страница 2"))
        self.assertLess(text.index("Страница 2"), text.index("Страница 3"))
        self.assertNotIn("\x00", text)
        self.assertNotIn("\ufeff", text)
        self.assertNotIn("\f", text)
        self.assertEqual(self.calls[1][4], "rus+eng+kaz")
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(warnings), 1)
        self.assertTrue(warnings[0].startswith("Применено локальное OCR Tesseract:"))
        self.assertNotIn("Windows", warnings[0])
        self.assert_staging_removed()

    def test_kazakh_is_optional_but_russian_and_english_are_required(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(languages=b"eng\nrus\n")):
            self.recognize()
        self.assertEqual(self.calls[-1][4], "rus+eng")
        for languages in (b"eng\nkaz\n", b"rus\nkaz\n", b"rus-eng\n", b""):
            with self.subTest(languages=languages):
                self.calls.clear()
                with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(languages=languages)):
                    with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "русский и английский"):
                        self.recognize()
                self.assertEqual(len(self.calls), 1)
        self.assert_staging_removed()

    def test_timeout_or_failed_process_never_exposes_paths_or_private_output(self):
        self.document(["scan"])
        cases = (
            {"fail_listing": subprocess.TimeoutExpired("private-path", 1, output="private text")},
            {"fail_page": subprocess.TimeoutExpired("private-path", 1, stderr="private text")},
            {"fail_listing": OSError("private-server-path")},
            {"fail_page": 1},
            {"fail_listing": 1},
        )
        for options in cases:
            with self.subTest(options=list(options)):
                with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(**options)):
                    with self.assertRaises(pdf_ocr.PDFOCRError) as error:
                        self.recognize()
                self.assertNotIn("private", str(error.exception))
                self.assertNotIn(str(self.root), str(error.exception))
        self.assert_staging_removed()

    def test_malformed_or_oversized_language_listing_is_rejected(self):
        self.document(["scan"])
        for languages in (b"\xffprivate-text", b"a" * 64_001):
            with self.subTest(size=len(languages)):
                self.calls.clear()
                with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(languages=languages)):
                    with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "некорректный список"):
                        self.recognize()
                self.assertEqual(len(self.calls), 1)
        self.assert_staging_removed()

    def test_malformed_or_deleted_output_is_safe_and_cleans_staging(self):
        self.document(["scan"])
        for options in ({"corrupt": True}, {"remove_output": True}):
            with self.subTest(options=options):
                with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(**options)):
                    with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "некорректный результат") as error:
                        self.recognize()
                self.assertNotIn("private", str(error.exception))
        self.assert_staging_removed()

    def test_per_page_and_aggregate_output_limits_reject_partial_text(self):
        self.document(["scan", "scan"])
        for text in ("а" * 101, "a" * 501, "а" * 60):
            with self.subTest(length=len(text)):
                with patch.object(pdf_ocr, "MAX_CHARS", 100), \
                        patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(text=text)):
                    with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком много"):
                        self.recognize()
        self.assert_staging_removed()

    def test_empty_ocr_output_does_not_fabricate_page_text(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.subprocess, "run", side_effect=self.process(text="\n\f")):
            text, warnings = self.recognize()
        self.assertEqual(text, "")
        self.assertTrue(any("не обнаружило читаемого текста" in warning for warning in warnings))
        self.assert_staging_removed()

    def test_global_budget_exhaustion_stops_before_any_process(self):
        self.document(["scan"])
        with patch.object(pdf_ocr.time, "monotonic", side_effect=[0, pdf_ocr.MAX_SECONDS + 1]), \
                patch.object(pdf_ocr.subprocess, "run") as process:
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком долго"):
                self.recognize()
        process.assert_not_called()
        self.assert_staging_removed()

    def test_global_budget_exhaustion_after_one_page_prevents_partial_result(self):
        self.document(["scan", "scan"])
        clock = [0]
        process = self.process()
        def finish_after_budget(arguments, **kwargs):
            result = process(arguments, **kwargs)
            if arguments[1:] != ["--list-langs"]:
                clock[0] = pdf_ocr.MAX_SECONDS + 1
            return result
        with patch.object(pdf_ocr.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(pdf_ocr.subprocess, "run", side_effect=finish_after_budget):
            with self.assertRaisesRegex(pdf_ocr.PDFOCRError, "слишком долго"):
                self.recognize()
        self.assertEqual(len(self.calls), 2)
        self.assert_staging_removed()

    @unittest.skipUnless(sys.platform.startswith("linux") and os.environ.get("QSTUDY_REAL_OCR_TEST") == "1",
                         "Real Tesseract smoke test runs explicitly on Linux")
    def test_real_tesseract_recognizes_synthetic_image_only_pdf(self):
        # Use the deployment image's local Cyrillic font and synthetic text;
        # neither personal documents nor a cloud service are needed.
        font = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        self.assertTrue(font.is_file(), "Install fonts-dejavu-core for the Linux OCR smoke test")
        with pymupdf.open() as source:
            page = source.new_page(width=600, height=320)
            page.insert_font(fontname="qstudy-unicode", fontfile=str(font))
            for y, value in ((65, "QSTUDY COURSE PLAN"), (125, "WEEK 1 PRACTICE"),
                             (195, "РАСПИСАНИЕ ЗАНЯТИЙ"), (255, "НЕДЕЛЯ 1")):
                page.insert_text((25, y), value, fontname="qstudy-unicode", fontsize=30)
            image = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False).tobytes("png")
        with pymupdf.open() as document:
            document.new_page(width=600, height=320).insert_image(pymupdf.Rect(0, 0, 600, 320), stream=image)
            document.save(self.pdf)
        text, warnings = pdf_ocr.recognize_pdf(self.pdf)
        self.assertIn("COURSE PLAN", text.upper())
        self.assertIn("WEEK 1", text.upper())
        self.assertIn("РАСПИСАНИЕ ЗАНЯТИЙ", text.upper())
        self.assertIn("НЕДЕЛЯ 1", text.upper())
        self.assertTrue(any(warning.startswith("Применено локальное OCR Tesseract:") for warning in warnings))

    def test_configured_executable_must_be_absolute_existing_and_executable(self):
        with patch.dict(os.environ, {"TESSERACT_EXECUTABLE": str(self.executable)}):
            self.assertEqual(pdf_ocr._linux_tesseract(), self.executable.resolve())
        for value in ("tesseract", "../tesseract", str(self.root / "not-installed"), "private\x00path"):
            with self.subTest(value=value), patch.object(pdf_ocr.os, "environ", {"TESSERACT_EXECUTABLE": value}):
                with self.assertRaises(pdf_ocr.PDFOCRError) as error:
                    pdf_ocr._linux_tesseract()
                self.assertNotIn(value, str(error.exception))
        with patch.dict(os.environ, {"TESSERACT_EXECUTABLE": str(self.executable)}), \
                patch.object(pdf_ocr.os, "access", return_value=False):
            with self.assertRaises(pdf_ocr.PDFOCRError):
                pdf_ocr._linux_tesseract()


if __name__ == "__main__":
    unittest.main()
