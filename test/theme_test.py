import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class ChromeBackgroundTest(unittest.TestCase):
    def test_chrome_view_background_matches_theme(self):
        """The GTK chrome view paints the theme color under Hog's pages."""
        retro = (ROOT / "public" / "retro.css").read_text()
        theme_bg = re.search(r"--bg:\s*(#[0-9a-fA-F]{6});", retro).group(1).lower()
        hog = (ROOT / "hog").read_text()
        parsed = [value.lower() for value in re.findall(r'background\.parse\("(#[0-9a-fA-F]{6})"\)', hog)]
        self.assertIn(theme_bg, parsed)
        # Web pages keep the white default that sites expect.
        self.assertIn("#ffffff", parsed)

    def test_intro_flash_matches_chrome_view_background(self):
        """Before the page paints, the GTK view shows the same black as the intro flash."""
        retro = (ROOT / "public" / "retro.css").read_text()
        theme_bg = re.search(r"--bg:\s*(#[0-9a-fA-F]{6});", retro).group(1).lower()
        app_css = (ROOT / "public" / "app.css").read_text()
        flash = re.search(r"\.boot-flash \{[^}]*background:\s*(#[0-9a-fA-F]{6})", app_css).group(1).lower()
        self.assertEqual(flash, theme_bg)
        hog = (ROOT / "hog").read_text()
        parsed = [value.lower() for value in re.findall(r'background\.parse\("(#[0-9a-fA-F]{6})"\)', hog)]
        self.assertIn(flash, parsed)

    def test_in_page_menu_uses_theme_palette(self):
        hog = (ROOT / "hog").read_text()
        self.assertNotIn("255,79,216", hog)
        self.assertNotIn("62,240,255", hog)
        self.assertIn("#111214", hog)
        self.assertNotIn("192,132,252", hog)
        self.assertNotIn("#c084fc", hog)

    def test_chrome_view_background_is_black_family(self):
        retro = (ROOT / "public" / "retro.css").read_text()
        theme_bg = re.search(r"--bg:\s*(#[0-9a-fA-F]{6});", retro).group(1)
        r, g, b = (int(theme_bg[i:i + 2], 16) for i in (1, 3, 5))
        self.assertLessEqual(max(r, g, b), 0x14, "the page background is near black")
        self.assertLessEqual(max(r, g, b) - min(r, g, b), 4, "the page background is neutral, not navy")


if __name__ == "__main__":
    unittest.main()
