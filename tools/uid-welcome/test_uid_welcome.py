import unittest

import uid_welcome as w

FP = {"ckFirst"}


def meta(**rows):
    return {int(k[1:]): v for k, v in rows.items()}


class Diff(unittest.TestCase):
    def test_first_run_posts_nothing_but_writes_state(self):
        m = meta(u1=("h1", "cA", 0), u2=("h2", "cB", 500))
        groups, inc, state = w.diff(None, m, FP)
        self.assertEqual((groups, inc), ({}, []))
        self.assertEqual(state, {1: ("h1", "cA", False), 2: ("h2", "cB", True)})
        self.assertEqual(w.build_messages(groups, inc), [])

    def test_new_uids_grouped_by_coldkey(self):
        prev = {1: ("h1", "cA", False)}
        m = meta(u1=("h1", "cA", 0), u2=("h2", "cB", 0), u3=("h3", "cB", 0), u4=("h4", "cC", 0), u5=("h5", "cB", 0))
        groups, inc, _ = w.diff(prev, m, FP)
        self.assertEqual(groups, {"cB": [2, 3, 5], "cC": [4]})
        msgs = w.build_messages(groups, inc)
        self.assertEqual(len(msgs), 2)
        self.assertIn("UIDs 2, 3 and 5 just registered (one coldkey)", msgs[0])
        self.assertIn("UID 4 just registered.", msgs[1])
        self.assertNotIn("cB", "".join(msgs))
        self.assertIn(w.QUICKSTART, msgs[0])
        self.assertIn(w.PEERING, msgs[0])

    def test_first_party_skipped(self):
        prev = {1: ("h1", "cA", False)}
        m = meta(u1=("h1", "cA", 0), u2=("h2", "ckFirst", 900), u3=("h3", "cB", 0))
        groups, inc, state = w.diff(prev, m, FP)
        self.assertEqual(groups, {"cB": [3]})
        self.assertEqual(inc, [])
        self.assertTrue(state[2][2])  # recorded, never reported

    def test_hotkey_change_counts_as_new(self):
        prev = {1: ("h1", "cA", True)}
        groups, inc, state = w.diff(prev, meta(u1=("h1new", "cB", 0)), FP)
        self.assertEqual(groups, {"cB": [1]})
        self.assertEqual(state[1], ("h1new", "cB", False))  # incentive history resets

    def test_first_incentive_once_per_hotkey(self):
        prev = {1: ("h1", "cA", False)}
        _, inc, state = w.diff(prev, meta(u1=("h1", "cA", 10)), FP)
        self.assertEqual(inc, [1])
        self.assertEqual(w.build_messages({}, inc), ["\U0001F4C8 UID 1 earned its first incentive on testnet 611."])
        _, inc2, state2 = w.diff(state, meta(u1=("h1", "cA", 12)), FP)  # next hour
        self.assertEqual(inc2, [])
        _, inc3, state3 = w.diff(state2, meta(u1=("h1", "cA", 0)), FP)  # drops to 0
        _, inc4, _ = w.diff(state3, meta(u1=("h1", "cA", 7)), FP)  # back up
        self.assertEqual((inc3, inc4), ([], []))
        # a new hotkey on the same UID can earn its own first incentive
        _, inc5, _ = w.diff(state3, meta(u1=("hX", "cA", 7)), FP)
        self.assertEqual(inc5, [1])

    def test_unchanged_posts_nothing(self):
        prev = {1: ("h1", "cA", True)}
        self.assertEqual(w.diff(prev, meta(u1=("h1", "cA", 5)), FP)[:2], ({}, []))


class Cap(unittest.TestCase):
    def test_at_most_ten(self):
        msgs = [f"m{i}" for i in range(10)]
        self.assertEqual(w.cap(msgs), msgs)
        out = w.cap([f"m{i}" for i in range(25)])
        self.assertEqual(len(out), 10)
        self.assertEqual(out[:9], [f"m{i}" for i in range(9)])
        self.assertIn("16 more", out[9])


if __name__ == "__main__":
    unittest.main()
