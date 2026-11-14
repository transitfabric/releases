#!/usr/bin/env python3
"""Welcome new testers on Transit Fabric testnet subnet 611 in Discord.

Read-only: it queries storage on the Bittensor *testnet* and never signs or
submits anything. The pure steps (diff, group, messages, cap) take plain data
so test_uid_welcome.py needs no network.

State file: {"<uid>": [hotkey, coldkey, ever_incentive_positive]}.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

NETUID = 611
RPC = os.environ.get("UID_WELCOME_RPC", "wss://test.finney.opentensor.ai:443")
MAINNET_GENESIS = "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03"
MAX_MECHANISMS = 2  # Invariant: mechid 0 (transit) and 1 (routing)
SUBNET_STRIDE = 4096  # Subtensor: mechanism storage index = mechid * 4096 + netuid
MAX_POSTS = 10
QUICKSTART = "https://transitfabric.xyz/quickstart.html"
PEERING = "https://github.com/transitfabric/releases/issues/new?template=peering-request.yml"


def fetch_metagraph(url=RPC, netuid=NETUID):
    """Step 1. Return {uid: (hotkey, coldkey, incentive)} from the testnet. Read-only."""
    from substrateinterface import SubstrateInterface

    sub = SubstrateInterface(url=url, ss58_format=42)
    if sub.get_block_hash(0) == MAINNET_GENESIS:
        raise SystemExit("refusing: this endpoint is mainnet")
    n = sub.query("SubtensorModule", "SubnetworkN", [netuid]).value
    keys = [sub.create_storage_key("SubtensorModule", "Keys", [netuid, u]) for u in range(n)]
    hotkeys = [r[1].value for r in sub.query_multi(keys)]
    owners = sub.query_multi([sub.create_storage_key("SubtensorModule", "Owner", [h]) for h in hotkeys])
    mechs = sub.query("SubtensorModule", "MechanismCountCurrent", [netuid]).value or 1
    inc = [0] * n
    for m in range(min(int(mechs), MAX_MECHANISMS)):
        vec = sub.query("SubtensorModule", "Incentive", [m * SUBNET_STRIDE + netuid]).value or []
        for u, v in enumerate(vec[:n]):
            inc[u] = max(inc[u], v)
    return {u: (hotkeys[u], owners[u][1].value, inc[u]) for u in range(n)}


def load_state(path):
    """Return the saved state, or None on the first run."""
    try:
        with open(path) as f:
            raw = json.load(f)
    except (FileNotFoundError, ValueError):
        return None
    return {int(u): tuple(v) for u, v in raw.items()}


def save_state(path, state):
    with open(path, "w") as f:
        json.dump({str(u): list(v) for u, v in sorted(state.items())}, f)


def diff(prev, meta, first_party):
    """Step 2-4. Return (new_by_coldkey, first_incentive_uids, new_state).

    prev is None on the first run: nothing is reported, state is just written.
    A UID whose hotkey changed (or that did not exist) is new and starts with
    ever_incentive_positive = False. First-party coldkeys are recorded but
    never reported.
    """
    new_state, new_by_ck, first_inc = {}, {}, []
    for uid, (hk, ck, inc) in sorted(meta.items()):
        old = (prev or {}).get(uid)
        is_new = prev is not None and (old is None or old[0] != hk)
        ever = bool(old[2]) if old is not None and old[0] == hk else False
        skip = ck in first_party
        if prev is not None and not skip:
            if is_new:
                new_by_ck.setdefault(ck, []).append(uid)
            if inc > 0 and not ever:
                first_inc.append(uid)
        new_state[uid] = (hk, ck, ever or inc > 0)
    return new_by_ck, first_inc, new_state


def uid_list(uids):
    s = [str(u) for u in uids]
    return s[0] if len(s) == 1 else ", ".join(s[:-1]) + " and " + s[-1]


def build_messages(new_by_ck, first_inc):
    """Group by coldkey, one welcome per coldkey, then one line per first incentive."""
    msgs = []
    for uids in sorted(new_by_ck.values(), key=lambda u: u[0]):
        if len(uids) == 1:
            who = f"UID {uids[0]} just registered"
        else:
            who = f"UIDs {uid_list(uids)} just registered (one coldkey)"
        msgs.append(f"\U0001F44B Welcome to Transit Fabric testnet {NETUID}! {who}. "
                    f"Next: the quick start {QUICKSTART}, then a peering request {PEERING}.")
    msgs += [f"\U0001F4C8 UID {u} earned its first incentive on testnet {NETUID}." for u in sorted(first_inc)]
    return msgs


def cap(msgs, limit=MAX_POSTS):
    """At most `limit` posts; if there are more, the last one is a summary line."""
    if len(msgs) <= limit:
        return msgs
    return msgs[: limit - 1] + [f"…and {len(msgs) - limit + 1} more testnet {NETUID} updates."]


def post(webhook, text):
    body = json.dumps({"username": "Transit Fabric", "content": text, "flags": 4,
                       "allowed_mentions": {"parse": []}}).encode()
    req = urllib.request.Request(webhook, body, {"Content-Type": "application/json",
                                                 "User-Agent": "transit-fabric-uid-welcome"})
    for attempt in (1, 2):
        try:
            urllib.request.urlopen(req, timeout=20).read()
            return
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 2:
                raise
            time.sleep(min(float(json.loads(e.read() or b"{}").get("retry_after", 2)), 30))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    first_party = {c.strip() for c in os.environ.get("FIRST_PARTY_COLDKEYS", "").split(",") if c.strip()}
    webhook = os.environ.get("DISCORD_WEBHOOK", "")
    if not a.dry_run and not webhook:
        raise SystemExit("DISCORD_WEBHOOK not set")

    meta = fetch_metagraph()
    prev = load_state(a.state)
    new_by_ck, first_inc, state = diff(prev, meta, first_party)
    print(f"{len(meta)} UIDs; {sum(map(len, new_by_ck.values()))} new, {len(first_inc)} first incentive"
          + ("; first run, posting nothing" if prev is None else ""))
    for i, text in enumerate(cap(build_messages(new_by_ck, first_inc))):
        if a.dry_run:
            print("DRY RUN:", text)
            continue
        if i:
            time.sleep(1)
        post(webhook, text)
    if not a.dry_run:  # state is saved only after every post went out
        save_state(a.state, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
