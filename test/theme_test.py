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

    def test_in_page_menu_uses_theme_palette(self):
        hog = (ROOT / "hog").read_text()
        self.assertNotIn("255,79,216", hog)
        self.assertNotIn("62,240,255", hog)
        self.assertIn("#0d1326", hog)


if __name__ == "__main__":
    unittest.main()
