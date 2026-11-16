"""The root miner helper recognizes a rig pointed at a tailnet Hog node."""
import types
import unittest
from pathlib import Path


def load_helper():
    path = Path(__file__).resolve().parents[1] / "electron" / "packaging" / "hog-miner-ctl"
    module = types.ModuleType("hog_miner_ctl")
    module.__file__ = str(path)
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), module.__dict__)
    return module


class MinerCtlPoolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helper = load_helper()

    def test_hog_pool_is_local_or_tailnet_only(self):
        yes = self.helper.on_hog_pool
        self.assertTrue(yes("stratum+tcp://127.0.0.1:3456"))
        self.assertTrue(yes("stratum+tcp://100.119.132.89:3456"))
        self.assertTrue(yes("stratum+tcp://hog.tail314642.ts.net:3456"))
        self.assertFalse(yes("stratum+tcp://8.8.8.8:3456"))
        self.assertFalse(yes("stratum+tcp://pool.us.woolypooly.com:3140"))
        self.assertFalse(yes("stratum+tcp://100.1.2.3:3456"))


if __name__ == "__main__":
    unittest.main()
